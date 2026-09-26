import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun } from '../db/repos/node-runs';
import { createTask, updateTaskStatus } from '../db/repos/tasks';
import { seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

// tick() and advanceFlowRun read their db via the getDatabase() singleton — point it at the
// per-test in-memory db. Dispatch is spied so a failed node cannot fan out real work.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('./dispatch', () => ({ dispatchNode: vi.fn() }));

import { tick } from './task-completion-watcher';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'agent1', blockType: 'agent', config: { instructions: 'go' }, position: { x: 0, y: 0 } },
  ],
  edges: [],
};

describe('task-completion-watcher — failed dispatch task fails the flow run', () => {
  let db: TestDb;
  let flowRunId: string;

  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
  });

  it('a task failed during dispatch (no chat created) fails the node and the run', async () => {
    // The wedged-flow shape: node parked awaiting_input, run paused, task failed by the
    // dispatch catch with only an error + attempt counter in result (no subChatId/chatId).
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent1',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    await setFlowRunStatus(db, flowRunId, 'paused');
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
    });
    await updateTaskStatus(db, task.id, 'failed', {
      result: {
        error: 'Cannot reuse flow worktree: Worktree path does not exist: /x',
        dispatchAttempts: 1,
      },
    });

    await tick();

    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
    const failedNode = await getNodeRun(db, node.id);
    expect(failedNode?.status).toBe('failed');
    expect(JSON.stringify(failedNode?.nodeOutput)).toContain('Worktree path does not exist');
  });
});
