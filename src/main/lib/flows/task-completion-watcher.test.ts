import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun } from '../db/repos/node-runs';
import { createTask, updateTaskStatus } from '../db/repos/tasks';
import { seedActiveAdmission, seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

// tick() and advanceFlowRun read their db via the getDatabase() singleton — point it at the
// per-test in-memory db. Dispatch is spied so a failed node cannot fan out real work.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('./dispatch', () => ({ dispatchNode: vi.fn() }));

import { eq } from 'drizzle-orm';
import { flowRunAdmissions } from '../db/schema';
import * as parkedResume from './admission/terminal-resume/parked-resume';
import * as advance from './advance';
import { tick, unparkQuietIdleFlowRun } from './task-completion-watcher';

const requestParkedFlowResume = vi.spyOn(parkedResume, 'requestParkedFlowResume');

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
    seedActiveAdmission(db, flowRunId);
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

describe('task-completion-watcher — finished nodes', () => {
  it('leaves a finished task alone once its node has finished too', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent1',
      blockType: 'agent',
      status: 'completed',
    });
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
    });
    await updateTaskStatus(db, task.id, 'done');
    const advanceSpy = vi.spyOn(advance, 'advanceFlowRun');

    await tick();

    expect(advanceSpy).not.toHaveBeenCalled();
    advanceSpy.mockRestore();
  });
});

describe('task-completion-watcher — a run that gave its slot up while it waited', () => {
  let db: TestDb;
  let flowRunId: string;

  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    requestParkedFlowResume.mockReset().mockResolvedValue({ state: 'queued', created: true });
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    const ticket = seedActiveAdmission(db, flowRunId);
    db.update(flowRunAdmissions)
      .set({ state: 'released', settledAt: new Date() })
      .where(eq(flowRunAdmissions.ticket, ticket))
      .run();
    await setFlowRunStatus(db, flowRunId, 'paused');
  });

  it('queues the run to take a slot back for a task that settled, instead of advancing without one', async () => {
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent1',
      blockType: 'agent',
      status: 'blocked',
    });
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
    });
    await updateTaskStatus(db, task.id, 'completed');

    await tick();

    expect(requestParkedFlowResume).toHaveBeenCalledWith({ flowRunId, nodeRunId: node.id });
    expect((await getNodeRun(db, node.id))?.status).toBe('blocked');
  });

  // Boot drops a resume claim a crash left behind as failed; the run is just as slot-less.
  it('also takes a slot back when the newest admission is a dropped resume claim', async () => {
    db.insert(flowRunAdmissions)
      .values({
        flowRunId,
        state: 'failed',
        priorityClass: 'resume',
        intentVersion: 1,
        intentJson: { version: 1, action: 'resume', flow_run_id: flowRunId, node_run_id: 'n' },
        settledAt: new Date(),
      })
      .run();
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent1',
      blockType: 'agent',
      status: 'blocked',
    });
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
    });
    await updateTaskStatus(db, task.id, 'completed');

    await tick();

    expect(requestParkedFlowResume).toHaveBeenCalledWith({ flowRunId, nodeRunId: node.id });
  });

  // The waiting resume advances the settled task when it is claimed; a second one would be refused.
  it('leaves the advance to a resume already waiting for a slot', async () => {
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent1',
      blockType: 'agent',
      status: 'blocked',
    });
    db.insert(flowRunAdmissions)
      .values({
        flowRunId,
        state: 'queued',
        priorityClass: 'resume',
        intentVersion: 1,
        intentJson: { version: 1, action: 'resume', flow_run_id: flowRunId, node_run_id: node.id },
      })
      .run();
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
    });
    await updateTaskStatus(db, task.id, 'completed');

    await tick();

    expect(requestParkedFlowResume).not.toHaveBeenCalled();
    expect((await getNodeRun(db, node.id))?.status).toBe('blocked');
  });

  // A boot wipes the watcher's dedup, so every parked row is re-read: a task still waiting on the
  // user must never queue a resume of its own, or the agent would carry on with nobody asking.
  it('never queues a resume for a task still waiting on the user', async () => {
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent1',
      blockType: 'agent',
      status: 'blocked',
    });
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
    });
    await updateTaskStatus(db, task.id, 'needs_attention');

    await tick();

    expect(requestParkedFlowResume).not.toHaveBeenCalled();
    expect((await getNodeRun(db, node.id))?.status).toBe('blocked');
  });

  it('keeps a slot-less run paused when a late signal supersedes its quiet park', async () => {
    await unparkQuietIdleFlowRun(db, 'task-1', flowRunId);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
  });
});
