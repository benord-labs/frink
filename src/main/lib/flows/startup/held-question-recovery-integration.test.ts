import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import { getFlowRun, recoverOrphanedFlowRuns } from '../../db/repos/flow-runs';
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

// The watcher and the resume path read the db through the getDatabase() singleton.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../dispatch', () => ({ dispatchNode: vi.fn() }));
vi.mock('../../socket/client', () => ({ broadcastTaskSignalPersisted: vi.fn() }));
vi.mock('../../sentry/init', () => ({
  captureMainException: vi.fn(),
  captureMainMessage: vi.fn(),
}));

import { captureMainMessage } from '../../sentry/init';
import { resumeParkedTaskInPlace } from '../../tasks';
import { _setFlowAdmissionControllerForTests } from '../admission/runtime';
import { tick } from '../task-completion-watcher';
import { parkQuestionsHeldAtShutdown } from './held-question-recovery';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'agent1', blockType: 'agent', config: { instructions: 'go' }, position: { x: 0, y: 0 } },
  ],
  edges: [],
};
const AFTER_BOOT = new Date(Date.now() + 60_000);

const held: TaskSignalPayload = {
  state: 'awaiting_input',
  summary: 'Needs your input: Scope',
  questions: [
    {
      question: 'Which scope?',
      header: 'Scope',
      options: [{ label: 'Narrow', description: 'Only this file' }],
      multiSelect: false,
    },
  ],
  at: '2026-10-02T00:00:00.000Z',
};

/** The boot order after this step: the restart sweeps, then the completion watcher's first tick. */
async function bootAfterCrash(db: TestDb): Promise<void> {
  parkQuestionsHeldAtShutdown(db);
  await recoverOrphanedFlowRuns(db, AFTER_BOOT);
  await recoverOrphanedNodeRuns(db, AFTER_BOOT);
  await recoverOrphanedTasks(db, AFTER_BOOT);
  await tick();
}

describe('a question held at a crash, through boot and the answer', () => {
  let db: TestDb;
  let flowRunId: string;
  let nodeRunId: string;
  let taskId: string;

  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    _setFlowAdmissionControllerForTests(null);
    vi.mocked(captureMainMessage).mockClear();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    // A RESUMED turn: un-park put both the node and the run back to running.
    nodeRunId = (
      await createNodeRun(db, {
        flowRunId,
        nodeId: 'agent1',
        blockType: 'agent',
        status: 'running',
        startedAt: new Date(),
      })
    ).id;
    taskId = (await createTask(db, { description: 'turn', source: 'flow', flowRunId, nodeRunId }))
      .id;
    await updateTaskStatus(db, taskId, 'running', { result: { subChatId: 'sub-1', chatId: 'c' } });
    await setHeldQuestionMarker(db, taskId, 'toolu_1', held);
  });

  it('stays parked on the question once the completion watcher runs — not stranded, not advanced', async () => {
    seedActiveAdmission(db, flowRunId);

    await bootAfterCrash(db);
    await tick();

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe('needs_attention');
    expect(parseResultRecord(task?.result).agentSignal).toEqual(held);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('awaiting_input');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect(captureMainMessage).not.toHaveBeenCalled();
  });

  it('an answer resumes the turn with the run running again', async () => {
    seedActiveAdmission(db, flowRunId);
    await bootAfterCrash(db);
    const parked = await getTaskById(db, taskId);
    if (!parked) throw new Error('task missing');

    expect(await resumeParkedTaskInPlace(parked, 'follow_up_message', 'sub-1')).toBe(true);

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe('running');
    expect(parseResultRecord(task?.result)).toMatchObject({ subChatId: 'sub-1', chatId: 'c' });
    expect(parseResultRecord(task?.result).agentSignal).toBeUndefined();
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  // Without a live slot the run cannot be paused, so the sweeps will cancel it. Parking the task and
  // node anyway would leave a question card on a dead run whose answer can never resume the flow.
  it('does not half-park a run it cannot pause — the ordinary restart recovery takes it', async () => {
    await bootAfterCrash(db);

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe('cancelled');
    expect(parseResultRecord(task?.result).heldQuestions).toBeUndefined();
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
  });
});
