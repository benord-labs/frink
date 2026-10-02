import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../sentry/init', () => ({ captureMainException: vi.fn() }));

import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import { getFlowRun, recoverOrphanedFlowRuns, setFlowRunStatus } from '../../db/repos/flow-runs';
import { createNodeRun, getNodeRun, recoverOrphanedNodeRuns } from '../../db/repos/node-runs';
import { setHeldQuestionMarker } from '../../db/repos/task-parking/held-question-marker';
import {
  createTask,
  getTaskById,
  parseResultRecord,
  recoverOrphanedTasks,
  updateTaskStatus,
} from '../../db/repos/tasks';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { liveAdmissionForRun } from '../admission/store';
import { HeldQuestionParkDeclined, parkHeldQuestionCommand, runTransition } from '../transitions';
import { parkQuestionsHeldAtShutdown } from './held-question-recovery';

const GRAPH = { nodes: [], edges: [], settings: {} };
const AFTER_BOOT = new Date(Date.now() + 60_000);

const heldSignal = (header: string, at: string): TaskSignalPayload => ({
  state: 'awaiting_input',
  summary: `Needs your input: ${header}`,
  questions: [
    {
      question: `Pick ${header}?`,
      header,
      options: [{ label: 'A', description: 'Option A' }],
      multiSelect: false,
    },
  ],
  at,
});

/** What the restart sweeps that follow this step do to the same rows. */
async function runRestartSweeps(db: TestDb) {
  await recoverOrphanedFlowRuns(db, AFTER_BOOT);
  await recoverOrphanedNodeRuns(db, AFTER_BOOT);
  return recoverOrphanedTasks(db, AFTER_BOOT);
}

describe('parkQuestionsHeldAtShutdown', () => {
  let db: TestDb;
  let flowRunId: string;

  beforeEach(async () => {
    db = freshDb();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    seedActiveAdmission(db, flowRunId);
  });

  async function heldFlowTask(nodeStatus: 'running' | 'awaiting_input' | 'completed') {
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent-1',
      blockType: 'agent',
      status: nodeStatus,
      startedAt: new Date(),
    });
    const task = await createTask(db, {
      description: 'step',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
    });
    await updateTaskStatus(db, task.id, 'running', {
      result: { subChatId: 'sc-1', chatId: 'c-1' },
    });
    await setHeldQuestionMarker(
      db,
      task.id,
      'toolu_1',
      heldSignal('Scope', '2026-10-02T00:00:00Z'),
    );
    return { taskId: task.id, nodeRunId: node.id };
  }

  it('parks a resumed-turn hold (run and node running) so the restart sweeps leave it alone', async () => {
    const { taskId, nodeRunId } = await heldFlowTask('running');

    expect(parkQuestionsHeldAtShutdown(db)).toBe(1);
    const swept = await runRestartSweeps(db);

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe('needs_attention');
    const result = parseResultRecord(task?.result);
    expect(result).toMatchObject({
      subChatId: 'sc-1',
      chatId: 'c-1',
      agentSignal: heldSignal('Scope', '2026-10-02T00:00:00Z'),
    });
    expect(result.heldQuestions).toBeUndefined();
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('awaiting_input');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    // Nothing for boot carry-on to stage, and the parked run keeps its slot.
    expect(swept.map((row) => row.id)).not.toContain(taskId);
    expect(liveAdmissionForRun(db, flowRunId)?.state).toBe('active');
  });

  it('changes only the task for a first-dispatch hold (run already paused, node awaiting_input)', async () => {
    await setFlowRunStatus(db, flowRunId, 'paused');
    const { taskId, nodeRunId } = await heldFlowTask('awaiting_input');

    expect(parkQuestionsHeldAtShutdown(db)).toBe(1);
    await runRestartSweeps(db);

    expect((await getTaskById(db, taskId))?.status).toBe('needs_attention');
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('awaiting_input');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
  });

  it('parks on the earliest of several holds', async () => {
    const { taskId } = await heldFlowTask('running');
    await setHeldQuestionMarker(
      db,
      taskId,
      'toolu_0',
      heldSignal('Earlier', '2026-10-01T23:00:00Z'),
    );

    parkQuestionsHeldAtShutdown(db);

    const signal = parseResultRecord((await getTaskById(db, taskId))?.result).agentSignal;
    expect(signal).toMatchObject({ summary: 'Needs your input: Earlier' });
  });

  it('parks a non-flow task on the task alone', async () => {
    const task = await createTask(db, { description: 'chat task', source: 'manual' });
    await updateTaskStatus(db, task.id, 'running', { result: { subChatId: 'sc-2' } });
    await setHeldQuestionMarker(db, task.id, 'toolu_9', heldSignal('Plan', '2026-10-02T00:00:00Z'));

    expect(parkQuestionsHeldAtShutdown(db)).toBe(1);

    expect((await getTaskById(db, task.id))?.status).toBe('needs_attention');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('leaves a task without a well-formed hold to the ordinary restart sweep', async () => {
    const plain = await createTask(db, { description: 'plain', source: 'flow', flowRunId });
    await updateTaskStatus(db, plain.id, 'running', { result: { subChatId: 'sc-3' } });
    const broken = await createTask(db, { description: 'broken', source: 'flow', flowRunId });
    await updateTaskStatus(db, broken.id, 'running', {
      result: { heldQuestions: { toolu_x: { summary: '' } } },
    });

    expect(parkQuestionsHeldAtShutdown(db)).toBe(0);
    await runRestartSweeps(db);

    expect((await getTaskById(db, plain.id))?.status).toBe('cancelled');
    const brokenRow = await getTaskById(db, broken.id);
    expect(brokenRow?.status).toBe('cancelled');
    // The cancel marker drops the hold, so no later boot can resurrect it.
    expect(parseResultRecord(brokenRow?.result).heldQuestions).toBeUndefined();
  });

  // A task still `running` over a node the flow already moved past is stale: parking it would pause
  // a run that has nothing waiting, so the run would sit paused forever.
  it('leaves a hold whose node already finished to the ordinary restart recovery', async () => {
    const { taskId, nodeRunId } = await heldFlowTask('completed');

    expect(parkQuestionsHeldAtShutdown(db)).toBe(0);

    expect((await getTaskById(db, taskId))?.status).toBe('running');
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('completed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('rolls the node and run back when the task left running before its own write', async () => {
    const { taskId, nodeRunId } = await heldFlowTask('running');
    const snapshot = await getTaskById(db, taskId);
    if (!snapshot) throw new Error('task missing');
    await updateTaskStatus(db, taskId, 'cancelled');

    expect(() =>
      runTransition(db, () => parkHeldQuestionCommand(db, snapshot, heldSignal('Scope', 'x'))),
    ).toThrow(HeldQuestionParkDeclined);

    expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });
});
