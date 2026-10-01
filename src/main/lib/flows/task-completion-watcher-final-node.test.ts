import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun, listNodeRunsForFlowRun } from '../db/repos/node-runs';
import { createTask, updateTaskStatus } from '../db/repos/tasks';
import { seedActiveAdmission, seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

// sc-2771: the LAST agent node's `done` must advance the run into the next node. getDatabase()
// points at the per-test in-memory db; dispatch is spied so the downstream dispatch is assertable.
const holder = vi.hoisted(() => ({
  db: null as unknown,
  captureMainMessage: vi.fn(),
  captureMainException: vi.fn(),
}));
vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('./dispatch', () => ({ dispatchNode: vi.fn() }));
vi.mock('../socket/client', () => ({ broadcastTaskSignalPersisted: vi.fn() }));
vi.mock('../sentry/init', () => ({
  captureMainMessage: holder.captureMainMessage,
  captureMainException: holder.captureMainException,
}));
// Real advanceFlowRun by default; the stranded-node case overrides one call.
vi.mock('./advance', async (orig) => {
  const actual = await orig<typeof import('./advance')>();
  return { ...actual, advanceFlowRun: vi.fn(actual.advanceFlowRun) };
});

import { persistLinkedTaskSignal } from '../trpc/routers/frink-task-signal-persist';
import { advanceFlowRun } from './advance';
import { dispatchNode } from './dispatch';
import { stopTaskCompletionWatcher, tick } from './task-completion-watcher';

// implement(agent) → ship(agent): the Shortcut-flow tail where the stall was observed.
const GRAPH: FlowGraph = {
  nodes: [
    {
      id: 'implement',
      blockType: 'agent',
      config: { instructions: 'go' },
      position: { x: 0, y: 0 },
    },
    { id: 'ship', blockType: 'agent', config: { instructions: 'ship' }, position: { x: 1, y: 0 } },
  ],
  edges: [{ id: 'e1', source: 'implement', target: 'ship' }],
};

describe('task-completion-watcher — final agent node done advances into the next node', () => {
  let db: TestDb;
  let flowRunId: string;
  let nodeRunId: string;
  let taskId: string;

  beforeEach(async () => {
    stopTaskCompletionWatcher(); // clears the in-process dedup sets between tests
    holder.captureMainMessage.mockReset();
    (dispatchNode as Mock).mockReset();
    db = freshDb();
    holder.db = db;
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    seedActiveAdmission(db, flowRunId);
    // The agent handoff steady state (advance.ts parkAwaitingInput): node awaiting_input, run
    // paused, the node's task running under the agent.
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'implement',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    nodeRunId = node.id;
    await setFlowRunStatus(db, flowRunId, 'paused');
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId,
    });
    taskId = task.id;
    await updateTaskStatus(db, taskId, 'running');
  });

  it('completes the node, dispatches the next node once, and completes the run', async () => {
    (dispatchNode as Mock).mockResolvedValue({
      type: 'completed',
      output: { status: 'completed', outputs: {}, artifacts: [], durationMs: 0 },
    });

    const persisted = await persistLinkedTaskSignal({
      taskIdForExecution: taskId,
      signal: { state: 'done', summary: 'Edge cases covered', at: new Date().toISOString() },
    });
    expect(persisted).toBe(true);

    await tick();

    expect((await getNodeRun(db, nodeRunId))?.status).toBe('completed');
    expect(dispatchNode).toHaveBeenCalledTimes(1);
    const shipRuns = (await listNodeRunsForFlowRun(db, flowRunId)).filter(
      (n) => n.nodeId === 'ship',
    );
    expect(shipRuns).toHaveLength(1);
    expect(shipRuns[0]?.status).toBe('completed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('completed');

    // A later tick must not re-dispatch the downstream node.
    await tick();
    expect(dispatchNode).toHaveBeenCalledTimes(1);
    expect(holder.captureMainMessage).not.toHaveBeenCalled();
  });

  it('reports a terminal task that did not advance its still-active node, once', async () => {
    await persistLinkedTaskSignal({
      taskIdForExecution: taskId,
      signal: { state: 'done', summary: 'Edge cases covered', at: new Date().toISOString() },
    });
    // The guarded node write matched nothing although the row is unchanged: the dedup entry is
    // kept on the premise that the node is terminal — here it is not, so the run would stall.
    vi.mocked(advanceFlowRun).mockResolvedValueOnce(false);

    await tick();
    await tick();

    expect((await getNodeRun(db, nodeRunId))?.status).toBe('awaiting_input');
    expect(holder.captureMainMessage).toHaveBeenCalledTimes(1);
    expect(holder.captureMainMessage).toHaveBeenCalledWith(
      'Flow node stranded behind a terminal task',
      'warning',
      expect.objectContaining({ taskId, nodeRunId, nodeStatus: 'awaiting_input' }),
    );
  });
});
