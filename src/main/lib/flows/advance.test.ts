import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import {
  type FlowExecutionEvent,
  type NodeOutput,
  RESTART_INTERRUPTION_REASON,
} from '../../../shared/types/flow';
import { hardDeleteFlow } from '../db/repos/flow-deletion';
import {
  getFlowRun,
  getOrCreateFlowRunByIdempotencyKey,
  setFlowRunStatus,
} from '../db/repos/flow-runs';
import { getFlowById } from '../db/repos/flows';
import {
  createNodeRun,
  getNodeRun,
  listNodeRunsForFlowRun,
  setNodeRunStatus,
} from '../db/repos/node-runs';
import {
  cancelFlowLinkedTasksForRun,
  createTask,
  getTaskById,
  updateTaskStatus,
} from '../db/repos/tasks';
import { flowRunAdmissions, flowRuns } from '../db/schema';
import {
  seedActiveAdmission,
  seedCompletedNodeRun,
  seedFlowRun,
} from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import {
  clearActiveFlowTaskForChat,
  getActiveFlowTaskForChat,
  setActiveFlowTaskForChat,
} from '../task-executor';

// advanceFlowRun reads its db via the getDatabase() singleton — point it at the per-test
// in-memory db so the guard reads (getFlowRun / setNodeRunStatus / loadRunContext) hit seeded rows.
const holder = vi.hoisted(() => ({
  db: null as unknown,
  cancelUndispatchedFlowAdmission: vi.fn(),
  requestFlowAdmissionRelease: vi.fn(),
}));
vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
// Spy on dispatch so we can assert a re-advance does NOT re-dispatch a downstream node.
vi.mock('./dispatch', () => ({ dispatchNode: vi.fn() }));
vi.mock('./admission/runtime', async (original) => ({
  ...(await original<typeof import('./admission/runtime')>()),
  cancelUndispatchedFlowAdmission: holder.cancelUndispatchedFlowAdmission,
  requestFlowAdmissionRelease: holder.requestFlowAdmissionRelease,
}));
// Mocked so the contained-error report is assertable, and so its lazy `./init` import never
// pulls @sentry/electron (and `electron`, unmocked here) into this suite.
const captureContainedMock = vi.fn();
vi.mock('../sentry', () => ({
  captureContained: (...args: unknown[]) => captureContainedMock(...args),
}));

import { advanceFlowRun, dispatchAndAdvance, loadRunContext } from './advance';
import { _setFlowAdmissionControllerForTests } from './admission/runtime';
import { abortFlowRun, registerNodeAbort } from './cancel-registry';
import { deleteFlow, settleChatOwnedFlowDeletion } from './deletion';
import { dispatchNode } from './dispatch';
import { cancelFlowRun, cancelFlowRunForChatDeletion, cancelFlowRunsForChat } from './engine';
import { subscribeFlowEvents } from './events';
import { type RunFence, readRunFence } from './transitions';
import { loadBodyMember, loadFanOutState, saveBodyMembers, saveFanOutState } from './fan-out-state';

afterEach(() => {
  holder.cancelUndispatchedFlowAdmission.mockReset();
  holder.requestFlowAdmissionRelease.mockReset();
  _setFlowAdmissionControllerForTests(null);
});

// evaluate(agent) → cond → 6805(agent): the 203 shape. cond's edge is irrelevant to these
// tests (both bail before the edge walk), but loadRunContext needs a real version graph.
const GRAPH: FlowGraph = {
  nodes: [
    {
      id: 'evaluate',
      blockType: 'agent',
      config: { instructions: 'eval' },
      position: { x: 0, y: 0 },
    },
    { id: 'cond', blockType: 'condition', position: { x: 0, y: 1 } },
    {
      id: '6805',
      blockType: 'agent',
      config: { instructions: 'mark done' },
      position: { x: 0, y: 2 },
    },
  ],
  edges: [
    { id: 'e1', source: 'evaluate', target: 'cond' },
    { id: 'e2', source: 'cond', target: '6805', sourceHandle: 'false' },
  ],
};

const completedOutput: NodeOutput = {
  status: 'completed',
  outputs: {},
  artifacts: [],
  durationMs: 0,
};
const cancelledOutput: NodeOutput = {
  status: 'cancelled',
  outputs: {},
  artifacts: [],
  durationMs: 0,
  error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
};
const awaitingInputOutput: NodeOutput = {
  status: 'awaiting_input',
  outputs: { verification: { shouldProceed: true } },
  artifacts: [],
  durationMs: 0,
  signal: 'awaiting_input',
};

describe('setNodeRunStatus — CAS guard (expectStatuses)', () => {
  let db: TestDb;
  let flowRunId: string;
  beforeEach(async () => {
    db = freshDb();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
  });

  const ACTIVE = ['running', 'awaiting_input', 'blocked'] as const;

  it('rejects (null, no write) a re-flip of an already-terminal node', async () => {
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'evaluate',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'completed', { completedAt: new Date() });

    const result = await setNodeRunStatus(db, node.id, 'failed', { expectStatuses: ACTIVE });
    expect(result).toBeNull();
    expect((await getNodeRun(db, node.id))?.status).toBe('completed'); // unchanged
  });

  it('allows awaiting_input → cancelled (restart-cancel propagation must survive)', async () => {
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: '6805',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    const result = await setNodeRunStatus(db, node.id, 'cancelled', { expectStatuses: ACTIVE });
    expect(result?.status).toBe('cancelled');
  });

  it('without expectStatuses, flips unconditionally (back-compat for every other caller)', async () => {
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'evaluate',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'completed', {});
    const result = await setNodeRunStatus(db, node.id, 'failed', {}); // no guard → still writes
    expect(result?.status).toBe('failed');
  });
});

describe('advanceFlowRun — idempotent across restart (the 203 duplicate-dispatch bug)', () => {
  let db: TestDb;
  let flowRunId: string;
  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    (dispatchNode as Mock).mockReset();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    seedActiveAdmission(db, flowRunId);
    await setFlowRunStatus(db, flowRunId, 'paused'); // agent in flight keeps the run paused
  });

  it('re-advancing an already-completed node does NOT re-dispatch or create a duplicate node_run', async () => {
    const evalNode = await createNodeRun(db, {
      flowRunId,
      nodeId: 'evaluate',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, evalNode.id, 'completed', {
      nodeOutput: completedOutput,
      completedAt: new Date(),
    });

    // The watcher re-fires after a restart (empty in-memory dedup) against the completed node.
    await advanceFlowRun(flowRunId, evalNode.id, completedOutput);

    expect(dispatchNode).not.toHaveBeenCalled();
    const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
    expect(nodeRuns).toHaveLength(1); // no duplicate 6805 dispatch
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
  });

  it('a restart-cancelled agent task cancels the run AND finalizes a stray running task', async () => {
    const agentNode = await createNodeRun(db, {
      flowRunId,
      nodeId: '6805',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    // A second task re-dispatched right as the run cancels (the stuck-running divergence).
    const stray = await createTask(db, {
      description: '6805',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, stray.id, 'running');

    await advanceFlowRun(flowRunId, agentNode.id, cancelledOutput);

    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect((await getNodeRun(db, agentNode.id))?.status).toBe('cancelled');
    expect((await getTaskById(db, stray.id))?.status).toBe('cancelled'); // no orphan outliving its run
  });

  it('two advances of the same live node dispatch the next node EXACTLY once (tick races recursion)', async () => {
    // Models a 2s watcher tick firing the same completed task that the in-process
    // dispatchAndAdvance recursion is already advancing (or two panes racing). The
    // downstream node (`cond`) pauses so the chain stops after one dispatch.
    (dispatchNode as Mock).mockReturnValue({ type: 'awaiting_input', reason: 'paused' });
    const evalNode = await createNodeRun(db, {
      flowRunId,
      nodeId: 'evaluate',
      blockType: 'agent',
      status: 'running',
    });

    await advanceFlowRun(flowRunId, evalNode.id, completedOutput); // first: flips + dispatches cond
    await advanceFlowRun(flowRunId, evalNode.id, completedOutput); // second: CAS 0 rows → bails

    expect(dispatchNode).toHaveBeenCalledTimes(1);
    const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
    expect(nodeRuns.filter((n) => n.nodeId === 'cond')).toHaveLength(1); // no duplicate cond
  });

  // The fix's end state: an agent task that signals awaiting_input PAUSES the run instead of
  // advancing. The watcher calls advanceFlowRun with an awaiting_input NodeOutput; the node parks,
  // the run pauses, and the next node is never dispatched (no auto-swallow to `done`).
  it('pauses the run on an awaiting_input output and does not dispatch the next node', async () => {
    const evalNode = await createNodeRun(db, {
      flowRunId,
      nodeId: 'evaluate',
      blockType: 'agent',
      status: 'running',
    });

    await advanceFlowRun(flowRunId, evalNode.id, awaitingInputOutput);

    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect((await getNodeRun(db, evalNode.id))?.status).toBe('awaiting_input');
    expect(dispatchNode).not.toHaveBeenCalled(); // did NOT walk to `cond`
  });

  it("stamps pauseKind 'user' on run_paused when the awaiting_input came from a user Pause", async () => {
    // A user's own Pause reaches this same branch (park → watcher → advance);
    // the event marker is what keeps the renderer's 'parked' sound from
    // dinging the user for their own click.
    const evalNode = await createNodeRun(db, {
      flowRunId,
      nodeId: 'evaluate',
      blockType: 'agent',
      status: 'running',
    });
    const events: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((e) => {
      if (e.eventType === 'run_paused') events.push(e);
    });
    try {
      await advanceFlowRun(flowRunId, evalNode.id, { ...awaitingInputOutput, userPaused: true });
      expect(events).toHaveLength(1);
      expect(events[0].pauseKind).toBe('user');

      // And an agent-driven park (no marker) stays un-stamped.
      const again = await createNodeRun(db, {
        flowRunId,
        nodeId: 'evaluate',
        blockType: 'agent',
        status: 'running',
      });
      await setFlowRunStatus(db, flowRunId, 'running');
      await advanceFlowRun(flowRunId, again.id, awaitingInputOutput);
      expect(events).toHaveLength(2);
      expect(events[1].pauseKind).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("stamps pauseKind 'agent-handoff' when a dispatcher hands the node to an async worker", async () => {
    // Every agent node ends in a hand-off park: the engine waits on the dispatched task, not on
    // the user. Unstamped, that park is indistinguishable from "the flow needs you" and the
    // renderer chimes on every single node advance.
    (dispatchNode as Mock).mockReturnValue({
      type: 'awaiting_input',
      reason: 'agent task dispatched — awaiting completion',
      handoff: true,
    });
    const evalNode = await createNodeRun(db, {
      flowRunId,
      nodeId: 'evaluate',
      blockType: 'agent',
      status: 'running',
    });
    const events: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((e) => {
      if (e.eventType === 'run_paused') events.push(e);
    });
    try {
      await advanceFlowRun(flowRunId, evalNode.id, completedOutput); // walks to `cond`, which parks

      expect(events).toHaveLength(1);
      expect(events[0].pauseKind).toBe('agent-handoff');
    } finally {
      unsubscribe();
    }
  });
});

// A dispatcher that THROWS must still terminalize its node. The trigger entry point is
// `void runFlow(...).catch(log.error)` (start.ts), so without the catch in dispatchAndAdvance the
// only trace of a thrown dispatcher is one log line while the run sits in 'running' forever.
describe('dispatchAndAdvance — a thrown dispatcher terminalizes its node', () => {
  /** The seeded run's context, which dispatchAndAdvance takes as a required argument. */
  const ctxFor = async (id: string) => {
    const ctx = await loadRunContext(id);
    if (!ctx) throw new Error(`no run context for ${id}`);
    return ctx;
  };

  let db: TestDb;
  let flowRunId: string;
  let fence: RunFence;
  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    (dispatchNode as Mock).mockReset();
    captureContainedMock.mockReset();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    seedActiveAdmission(db, flowRunId);
    fence = readRunFence(db, flowRunId) as RunFence;
  });

  it('inserts no node_run and dispatches nothing once the run was cancelled', async () => {
    const ctx = await ctxFor(flowRunId);
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, ctx);

    expect(await listNodeRunsForFlowRun(db, flowRunId)).toEqual([]);
    expect(dispatchNode).not.toHaveBeenCalled();
    expect(abortFlowRun(flowRunId)).toBe(0);
  });

  it('does not revive a run cancelled while its dispatcher returns awaiting input', async () => {
    (dispatchNode as Mock).mockImplementation(async () => {
      await cancelFlowRun(flowRunId);
      return { type: 'awaiting_input', reason: 'late handoff', handoff: true };
    });

    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, await ctxFor(flowRunId));

    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
    expect(nodeRuns[0]?.status).toBe('cancelled');
  });

  it('marks the node and run failed instead of stranding them in running', async () => {
    (dispatchNode as Mock).mockRejectedValue(new Error('SQLITE_IOERR: disk I/O error'));

    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, await ctxFor(flowRunId));

    const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
    expect(nodeRuns[0]?.status).toBe('failed');
    expect((nodeRuns[0]?.nodeOutput as NodeOutput | undefined)?.error?.message).toContain(
      'SQLITE_IOERR',
    );
    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
    // The `finally` still unregisters, so a failed dispatch leaks no controller into the registry
    // (a leaked one would be aborted by an unrelated later cancel of the same run id).
    expect(abortFlowRun(flowRunId)).toBe(0);
  });

  // advanceFlowRun recurses into dispatchAndAdvance for the next node (advance.ts), so a
  // downstream throw unwinds through the upstream frame's try. The failure must be attributed to
  // the node that actually threw — the CAS guard (expectStatuses) is what stops the upstream
  // frame's catch from re-terminalizing an already-completed node.
  it('attributes a downstream throw to the node that threw, not its completed predecessor', async () => {
    (dispatchNode as Mock).mockImplementation(async (args: { node: { id: string } }) => {
      if (args.node.id === 'evaluate') return { type: 'completed', output: completedOutput };
      throw new Error('SQLITE_IOERR: disk I/O error');
    });

    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, await ctxFor(flowRunId));

    const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
    const evaluate = nodeRuns.find((n) => n.nodeId === 'evaluate');
    const cond = nodeRuns.find((n) => n.nodeId === 'cond');
    expect(evaluate?.status).toBe('completed'); // untouched by the downstream failure
    expect(cond?.status).toBe('failed');

    // Reported EXACTLY once. The frame that catches terminalizes and returns normally rather than
    // rethrowing, so the throw never reaches the upstream frame's catch — no duplicate report as
    // the recursion unwinds, and no need for an is-reported marker on the error.
    expect(captureContainedMock).toHaveBeenCalledTimes(1);
    expect(captureContainedMock).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'flow-dispatch',
      blockType: 'condition',
    });
  });

  // The three-frame version of the same property, because the recursion depth is what makes
  // duplicate reporting plausible: evaluate -> cond -> 6805, failing on the LAST node, so the
  // throw would have to pass through two upstream dispatchAndAdvance frames to be double-counted.
  // It does not: the owning frame terminalizes and returns normally instead of rethrowing, so the
  // upstream frames' try blocks complete and their catches never run.
  it('reports one event for one fault across a three-node chain, tagged with the failing node', async () => {
    (dispatchNode as Mock).mockImplementation(async (args: { node: { id: string } }) => {
      if (args.node.id === 'evaluate') return { type: 'completed', output: completedOutput };
      // `stop` routes the condition down its 'false' edge to 6805 rather than ending the run.
      if (args.node.id === 'cond') {
        return {
          type: 'completed',
          output: { ...completedOutput, outputs: { result: 'stop' } },
        };
      }
      throw new Error('SQLITE_IOERR: disk I/O error');
    });

    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, await ctxFor(flowRunId));

    const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
    expect(nodeRuns.find((n) => n.nodeId === 'evaluate')?.status).toBe('completed');
    expect(nodeRuns.find((n) => n.nodeId === 'cond')?.status).toBe('completed');
    expect(nodeRuns.find((n) => n.nodeId === '6805')?.status).toBe('failed');

    // One fault, one event — and tagged 'agent' (6805, which threw), never 'condition' or the
    // blockType of a node that completed.
    expect(captureContainedMock).toHaveBeenCalledTimes(1);
    expect(captureContainedMock).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'flow-dispatch',
      blockType: 'agent',
    });
  });

  // Dispatchers are not required to throw Error instances — a rejected non-Error must still
  // produce a readable failure rather than "undefined" or a crash inside the catch.
  it('records a readable message when a dispatcher throws a non-Error value', async () => {
    (dispatchNode as Mock).mockRejectedValue('plain string failure');

    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, await ctxFor(flowRunId));

    const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
    expect(nodeRuns[0]?.status).toBe('failed');
    expect((nodeRuns[0]?.nodeOutput as NodeOutput | undefined)?.error?.message).toBe(
      'plain string failure',
    );
  });

  // cancelFlowRun aborts the controller BEFORE it writes 'cancelled' (engine.ts), so a thrown
  // AbortError can reach the catch while the run is still non-terminal — advanceFlowRun's
  // terminal-run bail has nothing to bail on yet. The catch gates on the signal for exactly this.
  it('leaves an aborted node to the canceller rather than flipping the run to failed', async () => {
    (dispatchNode as Mock).mockImplementation(async () => {
      abortFlowRun(flowRunId); // the cancel path fires mid-dispatch
      throw new Error('Operation was aborted');
    });

    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, await ctxFor(flowRunId));

    // Untouched by the catch: the node stays as dispatch left it and the run keeps the status
    // cancelFlowRun is about to write. Without the signal gate both would read 'failed'.
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
    const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
    expect(nodeRuns[0]?.status).toBe('running');
  });
});

// A terminal run is a PURE no-op here: sweeping a `cancelled` run's live task would let the watcher
// re-terminalize work an in-place revive already brought back.
describe('cancelFlowRun — a terminal run is never swept', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'leaves a %s run and its live task untouched',
    async (status) => {
      const db = freshDb();
      holder.db = db;
      const { flowRunId } = await seedFlowRun(db, GRAPH);
      const task = await createTask(db, {
        description: 'live',
        source: 'flow',
        flowRunId,
      });
      await updateTaskStatus(db, task.id, 'running');
      await setFlowRunStatus(db, flowRunId, status);

      await cancelFlowRun(flowRunId);

      expect((await getFlowRun(db, flowRunId))?.status).toBe(status);
      expect((await getTaskById(db, task.id))?.status).toBe('running');
    },
  );
});

describe('cancelFlowRun — admission cancellation', () => {
  it('refuses to touch a run whose admission is no longer queued', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'running');
    holder.cancelUndispatchedFlowAdmission.mockResolvedValueOnce(false);

    await expect(cancelFlowRun(flowRunId, { queuedOnly: { ticket: 7 } })).resolves.toBeNull();

    // A dequeue must never become a stop: the queue surface only ever showed queued work, and the
    // clicked ticket travels down so a replacement admission for the same run is not cancelled.
    expect(holder.cancelUndispatchedFlowAdmission).toHaveBeenCalledWith(flowRunId, {
      states: ['queued'],
      ticket: 7,
    });
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('leaves a run that a replacement admission revived, having taken only its own ticket', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'running');
    // The clicked ticket was dequeued, but another admission has since put this run back to work.
    holder.cancelUndispatchedFlowAdmission.mockResolvedValueOnce(true);

    const result = await cancelFlowRun(flowRunId, { queuedOnly: { ticket: 7 } });

    expect(result?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('reports the run the admission transaction already terminalized', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    // Cancelling a queued start's admission terminalizes the run it never dispatched.
    holder.cancelUndispatchedFlowAdmission.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
      return true;
    });

    const result = await cancelFlowRun(flowRunId, { queuedOnly: { ticket: 7 } });

    expect(result?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
  });

  it('preserves a completed run while its admission is releasing', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'completed');
    await db.insert(flowRunAdmissions).values({
      flowRunId,
      state: 'releasing',
      priorityClass: 'start',
      intentVersion: 1,
      intentJson: { version: 1, action: 'start', flow_run_id: flowRunId },
    });
    const controller = new AbortController();
    registerNodeAbort(flowRunId, controller);

    await cancelFlowRunForChatDeletion(flowRunId, ['chat-deleting']);

    expect(controller.signal.aborted).toBe(false);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('completed');
    expect(holder.requestFlowAdmissionRelease).not.toHaveBeenCalled();
    abortFlowRun(flowRunId);
  });

  it('cancels only the deleting chat task in a shared run', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const deletingChatTask = await createTask(db, {
      description: 'deleting chat',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-deleting' },
    });
    const siblingChatTask = await createTask(db, {
      description: 'sibling chat',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-sibling' },
    });
    await updateTaskStatus(db, deletingChatTask.id, 'running');
    await updateTaskStatus(db, siblingChatTask.id, 'running');
    const controller = new AbortController();
    registerNodeAbort(flowRunId, controller);

    await cancelFlowRunForChatDeletion(flowRunId, ['chat-deleting']);

    expect(controller.signal.aborted).toBe(false);
    expect((await getTaskById(db, deletingChatTask.id))?.status).toBe('cancelled');
    expect((await getTaskById(db, siblingChatTask.id))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
    abortFlowRun(flowRunId);
  });

  it('aborts an unshared run while atomically cancelling its task', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'deleting chat',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-deleting' },
    });
    await updateTaskStatus(db, task.id, 'running');
    const controller = new AbortController();
    registerNodeAbort(flowRunId, controller);

    await cancelFlowRunForChatDeletion(flowRunId, ['chat-deleting']);

    expect(controller.signal.aborted).toBe(true);
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
  });

  it('cancels an unclaimed task through its run chat linkage', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'start',
      blockType: 'start_task',
      outputs: { chatId: 'chat-deleting' },
    });
    const task = await createTask(db, {
      description: 'not claimed yet',
      source: 'flow',
      flowRunId,
    });
    const controller = new AbortController();
    registerNodeAbort(flowRunId, controller);

    await cancelFlowRunForChatDeletion(flowRunId, ['chat-deleting']);

    expect(controller.signal.aborted).toBe(true);
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
  });

  it('archives terminal-run residue without removing parked review work', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const running = await createTask(db, {
      description: 'stale execution',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-archived' },
    });
    const parked = await createTask(db, {
      description: 'review later',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-archived' },
    });
    await updateTaskStatus(db, running.id, 'running');
    await updateTaskStatus(db, parked.id, 'needs_attention');
    await setFlowRunStatus(db, flowRunId, 'failed');

    await cancelFlowRunsForChat('chat-archived');

    expect((await getTaskById(db, running.id))?.status).toBe('cancelled');
    expect((await getTaskById(db, parked.id))?.status).toBe('needs_attention');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
  });

  it('archives one chat without cancelling a shared run or its sibling task', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const parked = await createTask(db, {
      description: 'review later',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-archived' },
    });
    const sibling = await createTask(db, {
      description: 'sibling still running',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-live' },
    });
    await updateTaskStatus(db, parked.id, 'needs_attention');
    await updateTaskStatus(db, sibling.id, 'running');

    await cancelFlowRunsForChat('chat-archived');

    expect((await getTaskById(db, parked.id))?.status).toBe('needs_attention');
    expect((await getTaskById(db, sibling.id))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).not.toBe('cancelled');
  });

  it('leaves parked review work available after a recoverable cancellation', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'review',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, task.id, 'needs_attention');
    await setFlowRunStatus(db, flowRunId, 'paused');

    await cancelFlowRun(flowRunId);

    expect((await getTaskById(db, task.id))?.status).toBe('needs_attention');
  });

  it('terminalizes a paused run after cancelling its queued resume admission', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'live resume task',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, task.id, 'running');
    await setFlowRunStatus(db, flowRunId, 'paused');
    const [{ ticket }] = await db
      .insert(flowRunAdmissions)
      .values({
        flowRunId,
        state: 'queued',
        priorityClass: 'resume',
        intentVersion: 1,
        intentJson: { version: 1, action: 'resume', flow_run_id: flowRunId },
      })
      .returning({ ticket: flowRunAdmissions.ticket });
    const events: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((event) => {
      if (event.eventType === 'run_cancelled') events.push(event);
    });

    try {
      const cancelled = await cancelFlowRun(flowRunId);

      expect(cancelled).toMatchObject({ status: 'cancelled', completedAt: expect.any(Date) });
      expect(await getFlowRun(db, flowRunId)).toMatchObject({
        status: 'cancelled',
        completedAt: expect.any(Date),
      });
      expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
      expect(
        db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, ticket)).get(),
      ).toMatchObject({ state: 'cancelled' });
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});

describe('deleteFlow — hard cutover', () => {
  it('bounds chat-owned deletion retries when Flow work never settles', async () => {
    vi.useFakeTimers();
    const attemptDelete = vi.fn(() => ({
      deleted: false as const,
      unsettledRunIds: ['missing-run'],
      chatIds: ['chat-1'],
    }));

    try {
      const deletion = settleChatOwnedFlowDeletion(
        attemptDelete,
        vi.fn(async () => undefined),
      );
      const assertion = expect(deletion).rejects.toThrow(
        'Deletion could not finish while Flow work was still stopping',
      );
      await vi.runAllTimersAsync();
      await assertion;
      expect(attemptDelete).toHaveBeenCalledTimes(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to delete a driving task whose parent run is terminal', async () => {
    const db = freshDb();
    const { flowId, flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'failed');
    const task = await createTask(db, {
      description: 'late admitted task',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, task.id, 'needs_attention');

    expect(hardDeleteFlow(db, flowId)).toEqual({
      deleted: false,
      unsettledRunIds: [flowRunId],
    });
    expect(await getTaskById(db, task.id)).not.toBeNull();
  });

  it('restores an enabled flow when its work never settles', async () => {
    vi.useFakeTimers();
    const db = freshDb();
    holder.db = db;
    const { flowId } = await seedFlowRun(db, GRAPH);

    try {
      const deletion = deleteFlow(
        flowId,
        vi.fn(async () => undefined),
      );
      const assertion = expect(deletion).rejects.toThrow(
        'Flow deletion could not finish while work was still stopping',
      );
      await vi.runAllTimersAsync();
      await assertion;
      expect(await getFlowById(db, flowId)).toMatchObject({ isEnabled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an active run and removes its run history and queue tasks', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowId, flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const task = await createTask(db, {
      description: 'active flow task',
      source: 'flow',
      flowRunId,
      result: { chatId: 'flow-chat' },
    });
    await updateTaskStatus(db, task.id, 'running');
    setActiveFlowTaskForChat('flow-chat', task.id);
    const ticket = seedActiveAdmission(db, flowRunId);
    holder.requestFlowAdmissionRelease.mockImplementation(() =>
      db
        .update(flowRunAdmissions)
        .set({ state: 'released', settledAt: new Date() })
        .where(eq(flowRunAdmissions.ticket, ticket))
        .run(),
    );

    await expect(deleteFlow(flowId)).resolves.toBe(true);

    expect(await getFlowById(db, flowId)).toBeNull();
    expect(await getFlowRun(db, flowRunId)).toBeNull();
    expect(await getTaskById(db, task.id)).toBeNull();
    expect(getActiveFlowTaskForChat('flow-chat')).toBeNull();
    expect(holder.requestFlowAdmissionRelease).toHaveBeenCalledWith(flowRunId, ticket);
  });

  it('preserves another flow task registered for the same chat', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowId, flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'failed');
    await createTask(db, {
      description: 'deleted flow task',
      source: 'flow',
      flowRunId,
      result: { chatId: 'shared-chat' },
    });
    setActiveFlowTaskForChat('shared-chat', 'new-flow-task');

    await deleteFlow(flowId);

    expect(getActiveFlowTaskForChat('shared-chat')).toBe('new-flow-task');
    clearActiveFlowTaskForChat('shared-chat');
  });

  it('aborts a controller even when the persisted run is already terminal', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowId, flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'completed');
    const controller = new AbortController();
    registerNodeAbort(flowRunId, controller);

    await deleteFlow(flowId);

    expect(controller.signal.aborted).toBe(true);
  });
});

describe('cancelFlowLinkedTasksForRun', () => {
  it('finalizes pending/running flow-linked tasks, leaves terminal ones untouched', async () => {
    const db = freshDb();
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const running = await createTask(db, {
      description: 'r',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, running.id, 'running');
    const pending = await createTask(db, {
      description: 'p',
      source: 'flow',
      flowRunId,
    });
    const done = await createTask(db, {
      description: 'd',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, done.id, 'done');

    const count = await cancelFlowLinkedTasksForRun(db, flowRunId);

    expect(count).toBe(2);
    expect((await getTaskById(db, running.id))?.status).toBe('cancelled');
    expect((await getTaskById(db, pending.id))?.status).toBe('cancelled');
    expect((await getTaskById(db, done.id))?.status).toBe('done'); // untouched
  });

  it('is scoped to its run — never touches another run’s tasks (concurrent runs / multi-pane)', async () => {
    const db = freshDb();
    // Two runs on the same version (one seedFlowRun project — its path is UNIQUE).
    const { versionId, flowRunId: runA } = await seedFlowRun(db, GRAPH, { idempotencyKey: 'a' });
    const { run: runB } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'b',
      startedAt: new Date(),
    });
    const taskA = await createTask(db, {
      description: 'a',
      source: 'flow',
      flowRunId: runA,
    });
    await updateTaskStatus(db, taskA.id, 'running');
    const taskB = await createTask(db, {
      description: 'b',
      source: 'flow',
      flowRunId: runB.id,
    });
    await updateTaskStatus(db, taskB.id, 'running');

    const count = await cancelFlowLinkedTasksForRun(db, runA);

    expect(count).toBe(1);
    expect((await getTaskById(db, taskA.id))?.status).toBe('cancelled');
    expect((await getTaskById(db, taskB.id))?.status).toBe('running'); // sibling run untouched
  });
});

describe('advanceFlowRun — run completion: review gate vs autoAcceptCompletedRuns', () => {
  // Single agent node with no outgoing edges: advancing its completed output ends the run.
  const soloGraph = (autoAccept?: boolean): FlowGraph => ({
    nodes: [
      { id: 'solo', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } },
    ],
    edges: [],
    ...(autoAccept === undefined ? {} : { settings: { autoAcceptCompletedRuns: autoAccept } }),
  });

  async function completeSoloRun(db: TestDb, graph: FlowGraph) {
    holder.db = db;
    (dispatchNode as Mock).mockReset();
    const { flowRunId } = await seedFlowRun(db, graph);
    seedActiveAdmission(db, flowRunId);
    const doneTask = await createTask(db, {
      description: 'solo',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, doneTask.id, 'done');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'solo',
      blockType: 'agent',
      status: 'running',
    });
    await advanceFlowRun(flowRunId, node.id, completedOutput);
    return { flowRunId, doneTask };
  }

  it("default (flag off): the run completes but its done task stays 'done' — user must accept", async () => {
    const db = freshDb();
    const { flowRunId, doneTask } = await completeSoloRun(db, soloGraph());

    expect((await getFlowRun(db, flowRunId))?.status).toBe('completed');
    expect((await getTaskById(db, doneTask.id))?.status).toBe('done');
  });

  it("flag on: run completion finalizes the run's done tasks straight to 'completed'", async () => {
    const db = freshDb();
    const { flowRunId, doneTask } = await completeSoloRun(db, soloGraph(true));

    expect((await getFlowRun(db, flowRunId))?.status).toBe('completed');
    expect((await getTaskById(db, doneTask.id))?.status).toBe('completed');
  });
});

describe('advanceFlowRun — empty Fan Out', () => {
  it('skips the contained body and dispatches the tail continuation with aggregate output', async () => {
    const db = freshDb();
    holder.db = db;
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out' },
        { id: 'body', blockType: 'agent', parentId: 'fan' },
        { id: 'after', blockType: 'agent' },
      ],
      edges: [
        { id: 'e1', source: 'fan', target: 'body' },
        { id: 'e2', source: 'body', target: 'after' },
      ],
    };
    const { flowRunId } = await seedFlowRun(db, graph);
    seedActiveAdmission(db, flowRunId);
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'running',
    });
    vi.mocked(dispatchNode)
      .mockReset()
      .mockResolvedValue({ type: 'awaiting_input', reason: 'test' });
    const output: NodeOutput = {
      status: 'completed',
      outputs: { results: [], totalCount: 0, _fanOutState: 'completed' },
      artifacts: [],
      durationMs: 0,
    };

    await advanceFlowRun(flowRunId, nodeRun.id, output);

    expect(dispatchNode).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ id: 'after' }),
        previousOutput: output,
      }),
    );
  });
});

describe('advanceFlowRun — branched Fan Out', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'fan', blockType: 'fan_out' },
      { id: 'a', blockType: 'agent', parentId: 'fan' },
      { id: 'b', blockType: 'agent', parentId: 'fan' },
      { id: 'after', blockType: 'agent' },
    ],
    edges: [
      { id: 'e1', source: 'fan', target: 'a' },
      { id: 'e2', source: 'fan', target: 'b' },
      { id: 'e3', source: 'a', target: 'after' },
      { id: 'e4', source: 'b', target: 'after' },
    ],
  };

  it('dispatches every branch root for the current item', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, graph);
    seedActiveAdmission(db, flowRunId);
    const fanRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'running',
    });
    vi.mocked(dispatchNode)
      .mockReset()
      .mockResolvedValue({ type: 'awaiting_input', reason: 'test' });
    const output: NodeOutput = {
      status: 'completed',
      outputs: {
        currentItem: 'item-1',
        currentIndex: 0,
        totalCount: 1,
        _fanOutState: 'iterating',
      },
      artifacts: [],
      durationMs: 0,
    };

    await advanceFlowRun(flowRunId, fanRun.id, output);

    expect(
      vi
        .mocked(dispatchNode)
        .mock.calls.map(([ctx]) => ctx.node.id)
        .sort(),
    ).toEqual(['a', 'b']);
    const branchRuns = (await listNodeRunsForFlowRun(db, flowRunId)).filter(
      (nodeRun) => nodeRun.parentFanOutNodeRunId === fanRun.id,
    );
    expect(branchRuns.map((nodeRun) => nodeRun.nodeId).sort()).toEqual(['a', 'b']);
    expect(branchRuns.every((nodeRun) => nodeRun.laneIndex === 0)).toBe(true);
  });

  it('claims racing final tails once and dispatches one nested aggregate', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId, flowId } = await seedFlowRun(db, graph);
    seedActiveAdmission(db, flowRunId);
    const fanRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    const branchRuns = await Promise.all(
      ['a', 'b'].map((nodeId) =>
        createNodeRun(db, {
          flowRunId,
          nodeId,
          blockType: 'agent',
          status: 'running',
          laneIndex: 0,
          parentFanOutNodeRunId: fanRun.id,
        }),
      ),
    );
    const branches = [
      { rootNodeId: 'a', tailNodeId: 'a', nodeIds: ['a'] },
      { rootNodeId: 'b', tailNodeId: 'b', nodeIds: ['b'] },
    ];
    await saveFanOutState(flowId, flowRunId, 'fan', {
      items: ['item-1'],
      currentIndex: 0,
      totalCount: 1,
      maxIterations: 50,
      completedOutputs: [],
      arrayField: 'items',
      branches,
    });
    await saveBodyMembers(flowId, flowRunId, ['a', 'b'], 'fan');
    (dispatchNode as Mock).mockReset().mockReturnValue({ type: 'awaiting_input', reason: 'test' });

    await Promise.all([
      advanceFlowRun(flowRunId, branchRuns[0]?.id ?? '', {
        ...completedOutput,
        outputs: { result: 'a' },
      }),
      advanceFlowRun(flowRunId, branchRuns[1]?.id ?? '', {
        ...completedOutput,
        outputs: { result: 'b' },
      }),
    ]);

    expect(dispatchNode).toHaveBeenCalledTimes(1);
    expect(dispatchNode).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ id: 'after' }),
        previousOutput: expect.objectContaining({
          outputs: {
            results: [{ a: { result: 'a' }, b: { result: 'b' } }],
            totalCount: 1,
            _fanOutState: 'completed',
          },
        }),
      }),
    );
    expect(await loadFanOutState(flowId, flowRunId, 'fan')).toBeNull();
    expect(await loadBodyMember(flowId, flowRunId, 'a')).toBeNull();
    expect(await loadBodyMember(flowId, flowRunId, 'b')).toBeNull();
  });

  it('returns the run to paused when another branch still needs input', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId, flowId } = await seedFlowRun(db, graph);
    seedActiveAdmission(db, flowRunId);
    const fanRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    const waitingBranch = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
      laneIndex: 0,
      parentFanOutNodeRunId: fanRun.id,
    });
    const completingBranch = await createNodeRun(db, {
      flowRunId,
      nodeId: 'b',
      blockType: 'agent',
      status: 'running',
      laneIndex: 0,
      parentFanOutNodeRunId: fanRun.id,
    });
    await saveFanOutState(flowId, flowRunId, 'fan', {
      items: ['item-1'],
      currentIndex: 0,
      totalCount: 1,
      maxIterations: 50,
      completedOutputs: [],
      arrayField: 'items',
      branches: [
        { rootNodeId: 'a', tailNodeId: 'a', nodeIds: ['a'] },
        { rootNodeId: 'b', tailNodeId: 'b', nodeIds: ['b'] },
      ],
    });
    await saveBodyMembers(flowId, flowRunId, ['a', 'b'], 'fan');

    await advanceFlowRun(flowRunId, completingBranch.id, completedOutput);

    expect((await getNodeRun(db, waitingBranch.id))?.status).toBe('awaiting_input');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
  });
});

describe('loadRunContext — batchId threading (member-suppression seam)', () => {
  it('stamps meta.batchId for a batch-member run and leaves it undefined otherwise', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);

    // Standalone run: no batchId on its emitted events.
    const standalone = await loadRunContext(flowRunId);
    expect(standalone?.meta.batchId).toBeUndefined();

    // Same run adopted into a batch: every event built from ctx.meta must now
    // carry the batchId, or the renderer's member-silencing goes dark.
    await db.update(flowRuns).set({ batchId: 'batch-ctx' }).where(eq(flowRuns.id, flowRunId));
    const member = await loadRunContext(flowRunId);
    expect(member?.meta.batchId).toBe('batch-ctx');
  });
});
