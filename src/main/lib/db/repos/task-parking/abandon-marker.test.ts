import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { type NodeOutput, RESTART_INTERRUPTION_REASON } from '../../../../../shared/types/flow';
import { seedFlowRun } from '../../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { setFlowRunStatus } from '../flow-runs';
import { createNodeRun, getNodeRun, recoverOrphanedNodeRuns, setNodeRunStatus } from '../node-runs';
import {
  createTask,
  getTaskById,
  getTaskCounts,
  listTasksWithProjectPaginated,
  recoverOrphanedTasks,
  type TaskFilterStatus,
  type TaskResultRecord,
  updateTaskStatus,
} from '../tasks';
import { abandonRestartInterruption } from './abandon-marker';

const GRAPH: FlowGraph = {
  nodes: [{ id: 'a', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } }],
  edges: [],
};
const INTERRUPTED_NODE_OUTPUT: NodeOutput = {
  status: 'cancelled',
  outputs: { text: 'partial' },
  artifacts: [],
  durationMs: 12,
  error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
};

describe('abandonRestartInterruption — an interrupted run becomes a deliberate Stop', () => {
  let db: TestDb;
  let flowRunId: string;
  beforeEach(async () => {
    db = freshDb();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
  });

  const display = async (statuses: TaskFilterStatus[]) =>
    (
      await listTasksWithProjectPaginated(db, {
        statuses,
        limit: 50,
        collapseByFlow: true,
      })
    ).items.map((i) => i.effectiveStatus);

  async function addMarkedTask(result: TaskResultRecord = {}) {
    const task = await createTask(db, { description: 'step', source: 'flow', flowRunId });
    await updateTaskStatus(db, task.id, 'cancelled', {
      result: { ...result, cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
    return task;
  }

  async function addNode(nodeOutput: NodeOutput, status: 'cancelled' | 'completed' = 'cancelled') {
    const node = await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' });
    await setNodeRunStatus(db, node.id, status, { completedAt: new Date(), nodeOutput });
    return node;
  }

  it('clears a task-only marker and keeps the task linkage', async () => {
    const task = await addMarkedTask({ subChatId: 'sc-1' });
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    expect(await display(['interrupted'])).toEqual(['interrupted']);

    expect(abandonRestartInterruption(db, flowRunId)).toBe(true);

    expect((await getTaskById(db, task.id))?.result).toEqual({
      subChatId: 'sc-1',
      cancelled: true,
    });
    expect(await display(['cancelled'])).toEqual(['cancelled']);
    expect(await display(['interrupted'])).toEqual([]);
    expect((await getTaskCounts(db, { collapseByFlow: true })).interrupted).toBe(0);
  });

  it('clears a node-only marker without touching the rest of the node output', async () => {
    await createTask(db, { description: 'prior', source: 'flow', flowRunId });
    const node = await addNode(INTERRUPTED_NODE_OUTPUT);
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(abandonRestartInterruption(db, flowRunId)).toBe(true);

    const after = await getNodeRun(db, node.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.nodeOutput).toEqual({
      status: 'cancelled',
      outputs: { text: 'partial' },
      artifacts: [],
      durationMs: 12,
    });
  });

  // The queue's marker read anchors on the NEWEST rows; the resume paths anchor on the LAST
  // UNFINISHED node_run. Clearing every marked row is what makes both read false.
  it('clears every marked row of the run, not only the newest', async () => {
    const older = await addNode(INTERRUPTED_NODE_OUTPUT);
    await addNode({ status: 'completed', outputs: {}, artifacts: [], durationMs: 1 }, 'completed');
    await addMarkedTask();
    await addMarkedTask();
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(abandonRestartInterruption(db, flowRunId)).toBe(true);

    expect((await getNodeRun(db, older.id))?.nodeOutput).not.toHaveProperty('error');
    expect(await display(['cancelled'])).toEqual(['cancelled']);
    expect(abandonRestartInterruption(db, flowRunId)).toBe(false);
  });

  it('is a no-op unless the run is cancelled', async () => {
    const task = await addMarkedTask();
    await setFlowRunStatus(db, flowRunId, 'running');

    expect(abandonRestartInterruption(db, flowRunId)).toBe(false);
    expect((await getTaskById(db, task.id))?.result).toMatchObject({
      error: RESTART_INTERRUPTION_REASON,
    });
  });

  it('is a no-op while a node_run of the run is live', async () => {
    const task = await addMarkedTask();
    const node = await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' });
    await setNodeRunStatus(db, node.id, 'running', {});
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(abandonRestartInterruption(db, flowRunId)).toBe(false);
    expect((await getTaskById(db, task.id))?.result).toMatchObject({
      error: RESTART_INTERRUPTION_REASON,
    });
  });

  it('is a no-op on a deliberate Stop', async () => {
    const task = await createTask(db, { description: 'x', source: 'flow', flowRunId });
    await updateTaskStatus(db, task.id, 'cancelled', { result: { cancelled: true } });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(abandonRestartInterruption(db, flowRunId)).toBe(false);
    expect((await getTaskById(db, task.id))?.result).toEqual({ cancelled: true });
  });

  it('stays cleared across the boot sweeps', async () => {
    await addMarkedTask();
    await addNode(INTERRUPTED_NODE_OUTPUT);
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    abandonRestartInterruption(db, flowRunId);

    expect(await recoverOrphanedTasks(db)).toEqual([]);
    expect(await recoverOrphanedNodeRuns(db)).toBe(0);
    expect(await display(['cancelled'])).toEqual(['cancelled']);
  });
});
