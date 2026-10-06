import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  capture: vi.fn(),
  gates: new Map<string, Promise<void>>(),
  afterInsert: null as (() => void) | null,
  onVersionRead: null as (() => Promise<void>) | null,
}));

vi.mock('../../db', async (original) => ({
  ...(await original<typeof import('../../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../../sentry/init', () => ({ captureMainException: holder.capture }));
vi.mock('../../sentry', () => ({ captureContained: holder.capture }));
vi.mock('../dispatch', () => ({ dispatchNode: vi.fn() }));
// A test lands a Cancel right after a node_run insert, before the dispatch registers its abort.
vi.mock('./index', async (original) => {
  const actual = await original<typeof import('./index')>();
  return {
    ...actual,
    insertNodeRunUnderCeiling: (...args: Parameters<typeof actual.insertNodeRunUnderCeiling>) => {
      const admitted = actual.insertNodeRunUnderCeiling(...args);
      if (admitted) holder.afterInsert?.();
      return admitted;
    },
  };
});
// A test lands a Cancel while an advance tail is loading its run context.
vi.mock('../../db/repos/flow-versions', async (original) => {
  const actual = await original<typeof import('../../db/repos/flow-versions')>();
  return {
    ...actual,
    getVersion: async (...args: Parameters<typeof actual.getVersion>) => {
      await holder.onVersionRead?.();
      return actual.getVersion(...args);
    },
  };
});
// A test parks a dispatch before its node_run insert by gating the loop-context read.
vi.mock('../fan-out-step', async (original) => {
  const actual = await original<typeof import('../fan-out-step')>();
  return {
    ...actual,
    buildLoopContextFor: async (flowRunId: string, nodeId: string) => {
      await holder.gates.get('loop-context');
      return actual.buildLoopContextFor(flowRunId, nodeId);
    },
  };
});

import type { FlowExecutionEvent, NodeOutput } from '../../../../shared/types/flow';
import { createChat, getChatById } from '../../db/repos/chats';
import {
  getFlowRun,
  getOrCreateFlowRunByIdempotencyKey,
  setFlowRunStatus,
} from '../../db/repos/flow-runs';
import { createNodeRun, getNodeRun, listNodeRunsForFlowRun } from '../../db/repos/node-runs';
import { createProject, deleteProject, getProjectById } from '../../db/repos/projects';
import { deleteChatWithFlowQueueTasks } from '../../db/repos/task-queries/chat-flow-cleanup';
import { createTask, getTaskById, updateTaskStatus } from '../../db/repos/tasks';
import { flowRunAdmissions, flowRuns, flowVersions } from '../../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { beginFlowResourceActivity } from '../admission/activity';
import type { FlowAdmissionConfig } from '../admission/config';
import {
  _resetFlowAdmissionControllerMutexForTests,
  FlowAdmissionController,
} from '../admission/controller';
import { _setFlowAdmissionControllerForTests, drainFlowAdmissions } from '../admission/runtime';
import '../admission/terminal-resume/dispatcher';
import { advanceFlowRun, dispatchAndAdvance, loadRunContext } from '../advance';
import { abortFlowRun, registerNodeAbort } from '../cancel-registry';
import { deleteFlow, settleChatOwnedFlowDeletion } from '../deletion';
import { dispatchNode } from '../dispatch';
import {
  cancelFlowRun,
  cancelFlowRunForChatDeletion,
  cancelFlowRunsForChat,
  cancelFlowRunsForChatOrThrow,
} from '../engine';
import { subscribeFlowEvents } from '../events';
import { resumeFlowRun } from '../resume';
import { cancelRunCommand, type RunFence, readRunFence } from '.';

const GRAPH = {
  nodes: [
    { id: 'work', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } },
  ],
  edges: [],
};

let db: TestDb;
let controller: FlowAdmissionController;
let flowRunId: string;
let flowId: string;
let config: FlowAdmissionConfig;
let cancelledEvents: FlowExecutionEvent[];
let unsubscribe: () => void;

/** Parks `name` until the returned release is called. */
function park(name: string): () => void {
  let release!: () => void;
  holder.gates.set(name, new Promise<void>((resolve) => (release = resolve)));
  return () => {
    holder.gates.delete(name);
    release();
  };
}

beforeEach(async () => {
  _resetFlowAdmissionControllerMutexForTests();
  holder.afterInsert = null;
  holder.onVersionRead = null;
  holder.capture.mockReset();
  (dispatchNode as Mock).mockReset();
  db = freshDb();
  holder.db = db;
  config = { version: 1, queuePaused: false, concurrencyLimitEnabled: false, maxConcurrentRuns: 4 };
  controller = new FlowAdmissionController(db, async () => {
    await holder.gates.get('config');
    return config;
  });
  _setFlowAdmissionControllerForTests(controller);
  ({ flowRunId, flowId } = await seedFlowRun(db, GRAPH));
  cancelledEvents = [];
  unsubscribe = subscribeFlowEvents((event) => {
    if (event.eventType === 'run_cancelled') cancelledEvents.push(event);
  });
});

afterEach(() => {
  unsubscribe();
  _setFlowAdmissionControllerForTests(null);
});

const runStatus = async () => (await getFlowRun(db, flowRunId))?.status;
const ticketState = (ticket: number) =>
  db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, ticket)).get()?.state;

/** A pending run with its start ticket waiting in the queue. */
function queueStart(
  triggerContext: Record<string, unknown> | null = null,
  runId = flowRunId,
): number {
  db.update(flowRuns)
    .set({ status: 'pending', startedAt: null, triggerContext })
    .where(eq(flowRuns.id, runId))
    .run();
  return db
    .insert(flowRunAdmissions)
    .values({
      flowRunId: runId,
      state: 'queued',
      priorityClass: 'start',
      intentVersion: 1,
      intentJson: { version: 1, action: 'start', flow_run_id: runId },
    })
    .returning({ ticket: flowRunAdmissions.ticket })
    .get().ticket;
}

/** Resolves on abort, recording the signal each dispatch received. */
function abortableDispatch(signals: AbortSignal[]): void {
  (dispatchNode as Mock).mockImplementation(
    (input: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        signals.push(input.signal);
        input.signal.addEventListener('abort', () =>
          resolve({ type: 'error', message: 'aborted' }),
        );
      }),
  );
}

/** A failed run with a Retry ticket waiting in the queue. */
async function queueRetry(): Promise<number> {
  await setFlowRunStatus(db, flowRunId, 'failed');
  const failed = await createNodeRun(db, {
    flowRunId,
    nodeId: 'work',
    blockType: 'agent',
    status: 'failed',
  });
  const { admission } = await controller.enqueueTerminalResume({ flowRunId, nodeRunId: failed.id });
  return admission.ticket;
}

describe('cancelRunCommand', () => {
  it('returns null for a missing run', () => {
    expect(cancelRunCommand(db, 'missing', { includeParked: false })).toBeNull();
  });

  it('drops a queued start before cancelling its pending run and its rows', async () => {
    const ticket = queueStart();
    const node = await createNodeRun(db, { flowRunId, nodeId: 'work', blockType: 'agent' });
    const task = await createTask(db, { description: 'start', source: 'flow', flowRunId });

    expect(cancelRunCommand(db, flowRunId, { includeParked: false })).toMatchObject({
      run: { status: 'cancelled' },
      cancelled: true,
      droppedTicket: true,
    });
    expect(ticketState(ticket)).toBe('cancelled');
    expect((await getNodeRun(db, node.id))?.status).toBe('cancelled');
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
  });

  it('leaves a promoted slot for the release that follows the commit', () => {
    const ticket = seedActiveAdmission(db, flowRunId);

    expect(cancelRunCommand(db, flowRunId, { includeParked: false })).toMatchObject({
      cancelled: true,
      droppedTicket: false,
      liveTicket: ticket,
    });
    expect(ticketState(ticket)).toBe('active');
  });

  it('keeps a terminal run, sweeping its parked work only for permanent deletion', async () => {
    await setFlowRunStatus(db, flowRunId, 'failed');
    const task = await createTask(db, { description: 'review', source: 'flow', flowRunId });
    await updateTaskStatus(db, task.id, 'needs_attention');

    expect(cancelRunCommand(db, flowRunId, { includeParked: false })).toMatchObject({
      run: { status: 'failed' },
      cancelled: false,
    });
    expect((await getTaskById(db, task.id))?.status).toBe('needs_attention');
    cancelRunCommand(db, flowRunId, { includeParked: true });
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
    expect(await runStatus()).toBe('failed');
  });
});

describe('Cancel against admission and dispatch', () => {
  it('cancels a Retry promoted before the Cancel, quietly and exactly once', async () => {
    const ticket = await queueRetry();
    const beginDispatch = controller.beginDispatch.bind(controller);
    vi.spyOn(controller, 'beginDispatch').mockImplementation(async (claimed) => {
      const promoted = await beginDispatch(claimed);
      void cancelFlowRun(flowRunId);
      await vi.waitFor(async () => expect(await runStatus()).toBe('cancelled'));
      return promoted;
    });

    await drainFlowAdmissions();

    await vi.waitFor(() => expect(ticketState(ticket)).not.toMatch(/active|releasing/));
    expect(await runStatus()).toBe('cancelled');
    expect(dispatchNode).not.toHaveBeenCalled();
    expect(cancelledEvents).toHaveLength(1);
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('drops a claimed ticket before beginDispatch promotes it', async () => {
    const ticket = await queueRetry();
    const releaseConfig = park('config');
    const draining = drainFlowAdmissions();
    const queued = new Promise<void>((resolve) => {
      const transition = controller.transition.bind(controller);
      vi.spyOn(controller, 'transition').mockImplementation((command, afterCommit) => {
        const result = transition(command, afterCommit);
        resolve();
        return result;
      });
    });
    const cancelling = cancelFlowRun(flowRunId);
    await queued;
    releaseConfig();
    await Promise.all([draining, cancelling]);

    expect(ticketState(ticket)).toBe('cancelled');
    expect(await runStatus()).toBe('failed');
    expect(dispatchNode).not.toHaveBeenCalled();
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('declines a dispatch parked before its node insert when a Cancel commits first', async () => {
    const releaseDispatch = park('loop-context');
    await queueRetry();
    await drainFlowAdmissions();
    await vi.waitFor(async () => expect(await runStatus()).toBe('running'));

    await cancelFlowRun(flowRunId);
    releaseDispatch();

    await vi.waitFor(async () =>
      expect((await listNodeRunsForFlowRun(db, flowRunId)).map((n) => n.status)).toEqual([
        'failed',
      ]),
    );
    expect(dispatchNode).not.toHaveBeenCalled();
    expect(await runStatus()).toBe('cancelled');
    expect(cancelledEvents).toHaveLength(1);
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('aborts a node inserted before the Cancel, in the commit tick, without failing the run', async () => {
    const signals: AbortSignal[] = [];
    let aborted = false;
    abortableDispatch(signals);
    await queueRetry();
    await drainFlowAdmissions();
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const [signal] = signals;

    const originalTransition = controller.transition.bind(controller);
    vi.spyOn(controller, 'transition').mockImplementation(async (command, afterCommit) =>
      originalTransition(command, (result) => {
        afterCommit?.(result);
        aborted = signal.aborted;
        return undefined;
      }),
    );
    await cancelFlowRun(flowRunId);

    expect(aborted).toBe(true);
    await vi.waitFor(async () =>
      expect((await listNodeRunsForFlowRun(db, flowRunId)).map((n) => n.status)).toEqual([
        'failed',
        'cancelled',
      ]),
    );
    expect(await runStatus()).toBe('cancelled');
    expect(cancelledEvents).toHaveLength(1);
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('aborts a node when a Cancel commits in the first microtask after its insert', async () => {
    const signals: AbortSignal[] = [];
    abortableDispatch(signals);
    holder.afterInsert = () => {
      holder.afterInsert = null;
      queueMicrotask(() => {
        cancelRunCommand(db, flowRunId, { includeParked: false });
        abortFlowRun(flowRunId);
      });
    };
    await queueRetry();
    await drainFlowAdmissions();

    await vi.waitFor(async () =>
      expect((await listNodeRunsForFlowRun(db, flowRunId)).map((n) => n.status)).toEqual([
        'failed',
        'cancelled',
      ]),
    );
    expect(await runStatus()).toBe('cancelled');
    expect(signals.length > 0 && signals.every((signal) => signal.aborted)).toBe(true);
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('refuses a Retry while a resume dispatch parked before the Cancel is in flight', async () => {
    const first = await queueRetry();
    const [failed] = await listNodeRunsForFlowRun(db, flowRunId);
    let resume!: () => void;
    const parked = new Promise<void>((resolve) => {
      holder.onVersionRead = () => {
        holder.onVersionRead = null;
        resolve();
        return new Promise<void>((release) => (resume = release));
      };
    });
    void drainFlowAdmissions();
    await parked;
    await cancelFlowRun(flowRunId);

    expect(ticketState(first)).toBe('releasing');
    await expect(
      controller.enqueueTerminalResume({ flowRunId, nodeRunId: failed.id }),
    ).rejects.toThrow('different live admission');
    resume();

    await vi.waitFor(() => expect(ticketState(first)).toBe('cancelled'));
    expect(await runStatus()).toBe('cancelled');
    expect(dispatchNode).not.toHaveBeenCalled();
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('releases only the slot it stopped, never a resume promoted while it emits', async () => {
    const stopped = seedActiveAdmission(db, flowRunId);
    let promoted = 0;
    holder.onVersionRead = async () => {
      holder.onVersionRead = null;
      db.update(flowRunAdmissions)
        .set({ state: 'released', settledAt: new Date() })
        .where(eq(flowRunAdmissions.ticket, stopped))
        .run();
      await setFlowRunStatus(db, flowRunId, 'running');
      promoted = seedActiveAdmission(db, flowRunId);
    };

    await cancelFlowRun(flowRunId);

    expect(promoted).toBeGreaterThan(stopped);
    expect(ticketState(promoted)).toBe('active');
  });

  it('keeps a Cancel that commits while an approved step is loading the run context', async () => {
    const terminal: string[] = [];
    const stop = subscribeFlowEvents((event) => {
      if (/^run_(completed|failed|cancelled)$/.test(event.eventType))
        terminal.push(event.eventType);
    });
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'work',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    seedActiveAdmission(db, flowRunId);
    holder.onVersionRead = async () => {
      if ((await getNodeRun(db, node.id))?.status !== 'completed') return;
      holder.onVersionRead = null;
      await cancelFlowRun(flowRunId);
    };

    await resumeFlowRun(flowRunId, 'approve', node.id);
    stop();

    expect(await runStatus()).toBe('cancelled');
    expect(terminal).toEqual(['run_cancelled']);
    expect(holder.capture).not.toHaveBeenCalled();
  });
});

const CANCEL_ENTRY_POINTS: [string, (id: string) => Promise<unknown>][] = [
  ['Cancel', (id) => cancelFlowRun(id)],
  ['chat deletion', (id) => cancelFlowRunForChatDeletion(id, ['chat-x'])],
];

describe('steps after a committed Cancel', () => {
  it.each(CANCEL_ENTRY_POINTS)(
    '%s keeps a committed Cancel and releases its slot when the terminal event fails',
    async (_, cancel) => {
      const ticket = seedActiveAdmission(db, flowRunId);
      holder.onVersionRead = async () => {
        holder.onVersionRead = null;
        throw new Error('emit failed');
      };

      await cancel(flowRunId);

      expect(await runStatus()).toBe('cancelled');
      await vi.waitFor(() => expect(ticketState(ticket)).not.toMatch(/active|releasing/));
      expect(holder.capture).toHaveBeenCalledWith(expect.any(Error), {
        surface: 'flow-cancel',
        stage: 'terminal-event',
      });
    },
  );

  it("a failed refill after a Cancel's settle is not reported as a Cancel failure", async () => {
    const ticket = seedActiveAdmission(db, flowRunId);
    vi.spyOn(controller, 'claimEligible').mockRejectedValueOnce(new Error('drain failed'));

    await cancelFlowRun(flowRunId);

    expect(ticketState(ticket)).not.toMatch(/active|releasing/);
    expect(holder.capture).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: 'flow-cancel' }),
    );
    // A clean pass clears the drainer's retry timer before the next test swaps the db.
    await drainFlowAdmissions();
  });

  it.each(CANCEL_ENTRY_POINTS)(
    '%s refills a limit-1 slot freed by dropping a claimed ticket',
    async (_, cancel) => {
      config = { ...config, concurrencyLimitEnabled: true, maxConcurrentRuns: 1 };
      const claimed = queueStart();
      db.update(flowRunAdmissions)
        .set({ state: 'claimed', claimedAt: new Date() })
        .where(eq(flowRunAdmissions.ticket, claimed))
        .run();
      const { run: other } = await getOrCreateFlowRunByIdempotencyKey(db, {
        flowVersionId: (await getFlowRun(db, flowRunId))?.flowVersionId ?? '',
        status: 'pending',
        triggerContext: null,
        idempotencyKey: 'k2',
      });
      const waiting = queueStart(null, other.id);
      abortableDispatch([]);

      await cancel(flowRunId);

      expect(ticketState(claimed)).toBe('cancelled');
      await vi.waitFor(() => expect(ticketState(waiting)).not.toBe('queued'));
      // The refilled run's dispatch must settle before the next test swaps the db.
      await cancelFlowRun(other.id);
      await vi.waitFor(() => expect(ticketState(waiting)).toMatch(/cancelled|completed|failed/));
    },
  );
});

const COMPLETED: NodeOutput = { status: 'completed', outputs: {}, artifacts: [], durationMs: 0 };
const FAILED: NodeOutput = {
  ...COMPLETED,
  status: 'failed',
  error: { message: 'boom', retryable: false },
};
const AWAITING_INPUT: NodeOutput = { ...COMPLETED, status: 'awaiting_input' };
const CHAIN = {
  nodes: [...GRAPH.nodes, { id: 'next', blockType: 'agent', position: { x: 0, y: 1 } }],
  edges: [{ id: 'e1', source: 'work', target: 'next' }],
};

describe('advance fenced on the admission ticket', () => {
  let terminal: string[];
  let stop: () => void;
  beforeEach(() => {
    terminal = [];
    stop = subscribeFlowEvents((event) => {
      if (/^run_(completed|failed|cancelled)$/.test(event.eventType))
        terminal.push(event.eventType);
    });
  });
  afterEach(() => stop());

  /** A live run on its active ticket, driving `work`; returns the ticket and the node. */
  async function liveRun(status: 'running' | 'paused' = 'running') {
    await setFlowRunStatus(db, flowRunId, status);
    const ticket = seedActiveAdmission(db, flowRunId);
    const nodeStatus = status === 'paused' ? 'awaiting_input' : 'running';
    const work = await createNodeRun(db, {
      flowRunId,
      nodeId: 'work',
      blockType: 'agent',
      status: nodeStatus,
    });
    return { ticket, work };
  }

  // The ceiling fails the run itself, through the same fenced endRun: a Cancel that commits while
  // the over-limit row is being failed must still own the run's terminal state.
  it('a Cancel committed while the dispatch ceiling fails a node wins over the failure', async () => {
    await setFlowRunStatus(db, flowRunId, 'running');
    const ticket = seedActiveAdmission(db, flowRunId);
    for (let i = 0; i < 50; i++) {
      await createNodeRun(db, {
        flowRunId,
        nodeId: 'work',
        blockType: 'agent',
        status: 'completed',
        admissionTicket: ticket,
      });
    }
    const ctx = await loadRunContext(flowRunId);
    const fence = readRunFence(db, flowRunId);
    if (!ctx || !fence) throw new Error('run is not live');
    // Fires on the advance's context read, after the over-limit row was written failed.
    holder.onVersionRead = async () => {
      const rows = await listNodeRunsForFlowRun(db, flowRunId);
      if (rows.at(-1)?.status !== 'failed') return;
      holder.onVersionRead = null;
      await cancelFlowRun(flowRunId);
    };

    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, ctx);

    expect(dispatchNode).not.toHaveBeenCalled();
    expect(await runStatus()).toBe('cancelled');
    expect(terminal).toEqual(['run_cancelled']);
  });

  it.each([
    ['a terminal write', GRAPH, COMPLETED, 'completed'],
    ['a next-node insert', CHAIN, COMPLETED, 'completed'],
    ['a failure abort', GRAPH, FAILED, 'failed'],
    ['a pause', GRAPH, AWAITING_INPUT, 'cancelled'],
  ])(
    'an advance decided before a Cancel and a Retry skips %s into the retried run',
    async (_, graph, output, staleNode) => {
      db.update(flowVersions).set({ graph }).where(eq(flowVersions.flowId, flowId)).run();
      const { ticket, work } = await liveRun();
      const signals: AbortSignal[] = [];
      abortableDispatch(signals);
      let retried = 0;
      holder.onVersionRead = async () => {
        holder.onVersionRead = null;
        await cancelFlowRun(flowRunId);
        const retry = await controller.enqueueTerminalResume({ flowRunId, nodeRunId: work.id });
        retried = retry.admission.ticket;
        await drainFlowAdmissions();
        await vi.waitFor(() => expect(dispatchNode).toHaveBeenCalledOnce());
      };

      await advanceFlowRun(flowRunId, work.id, output);

      expect(ticketState(ticket)).toBe('cancelled');
      expect(ticketState(retried)).toBe('active');
      expect(await runStatus()).toBe('running');
      const nodes = await listNodeRunsForFlowRun(db, flowRunId);
      expect(nodes.map((node) => [node.nodeId, node.status])).toEqual([
        ['work', staleNode],
        ['work', 'running'],
      ]);
      expect(dispatchNode).toHaveBeenCalledOnce();
      expect(signals.map((signal) => signal.aborted)).toEqual([false]);
      expect(terminal).toEqual(['run_cancelled']);
      expect(holder.capture).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['while the tail loads its context', 'run_cancelled'],
    ['after the tail completes the run', 'run_completed'],
  ])('a Cancel landing %s leaves exactly one terminal event', async (_, only) => {
    const { work } = await liveRun();
    if (only === 'run_cancelled') {
      holder.onVersionRead = async () => {
        holder.onVersionRead = null;
        await cancelFlowRun(flowRunId);
      };
    }

    await advanceFlowRun(flowRunId, work.id, COMPLETED);
    await cancelFlowRun(flowRunId);

    expect(terminal).toEqual([only]);
    expect(await runStatus()).toBe(only === 'run_cancelled' ? 'cancelled' : 'completed');
  });

  it('completes a paused run whose slot retained a teardown cleanup error', async () => {
    const { ticket, work } = await liveRun('paused');
    beginFlowResourceActivity(flowRunId)(new Error('teardown failed'));
    await vi.waitFor(() => expect(ticketState(ticket)).toBe('releasing'));

    await advanceFlowRun(flowRunId, work.id, COMPLETED);

    expect(await runStatus()).toBe('completed');
    expect(terminal).toEqual(['run_completed']);
    const slot = db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, ticket));
    expect(slot.get()).toMatchObject({ state: 'releasing', error: expect.any(String) });
  });
});

describe('removal through the Cancel command', () => {
  const parkedTask = async (
    chatId: string | null,
    status: 'needs_attention' | 'plan_ready' = 'needs_attention',
  ) => {
    const task = await createTask(db, {
      description: 'parked step',
      source: 'flow',
      flowRunId,
      result: chatId ? { chatId } : undefined,
    });
    await updateTaskStatus(db, task.id, status);
    return task;
  };

  it.each([
    ['delete', cancelFlowRunsForChatOrThrow],
    ['archive', cancelFlowRunsForChat],
  ])('chat %s cancels a run queued to start and emits once', async (_, removeChat) => {
    const chat = await createChat(db, { name: 'C' });
    const ticket = queueStart({ chatId: chat.id });

    await removeChat(chat.id);

    expect(await runStatus()).toBe('cancelled');
    expect(ticketState(ticket)).toBe('cancelled');
    expect(cancelledEvents).toHaveLength(1);
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('deletes a chat whose run has a queued Retry behind a paused queue in one pass', async () => {
    config = { ...config, queuePaused: true };
    const chat = await createChat(db, { name: 'C' });
    const ticket = await queueRetry();
    const task = await createTask(db, {
      description: 'done step',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    await updateTaskStatus(db, task.id, 'completed');
    const attemptDelete = vi.fn(() => deleteChatWithFlowQueueTasks(db, chat.id));

    await settleChatOwnedFlowDeletion(attemptDelete, cancelFlowRunForChatDeletion);

    expect(attemptDelete).toHaveBeenCalledTimes(2);
    expect(await getChatById(db, chat.id)).toBeNull();
    expect(ticketState(ticket)).toBe('cancelled');
  });

  it.each(['failed', 'cancelled', 'completed'] as const)(
    'deletes a chat whose %s run left a parked task, sparing a sibling chat on the same run',
    async (status) => {
      const chat = await createChat(db, { name: 'C' });
      const sibling = await createChat(db, { name: 'S' });
      const task = await parkedTask(chat.id);
      const siblingTask = await parkedTask(sibling.id);
      const node = await createNodeRun(db, { flowRunId, nodeId: 'work', blockType: 'agent' });
      await setFlowRunStatus(db, flowRunId, status);
      const attemptDelete = vi.fn(() => deleteChatWithFlowQueueTasks(db, chat.id));

      await settleChatOwnedFlowDeletion(attemptDelete, cancelFlowRunForChatDeletion);

      expect(attemptDelete).toHaveBeenCalledTimes(2);
      expect(await getChatById(db, chat.id)).toBeNull();
      expect(await getTaskById(db, task.id)).toBeNull();
      expect(await getChatById(db, sibling.id)).not.toBeNull();
      expect((await getTaskById(db, siblingTask.id))?.status).toBe('needs_attention');
      expect(await runStatus()).toBe(status);
      expect(await getNodeRun(db, node.id)).not.toBeNull();
      expect(cancelledEvents).toEqual([]);
    },
  );

  it.each(['needs_attention', 'plan_ready'] as const)(
    'deletes a chat that alone owns a failed run, with its %s task and the unclaimed one',
    async (status) => {
      const chat = await createChat(db, { name: 'C' });
      const task = await parkedTask(chat.id, status);
      const unclaimed = await parkedTask(null, status);
      await setFlowRunStatus(db, flowRunId, 'failed');
      const attemptDelete = vi.fn(() => deleteChatWithFlowQueueTasks(db, chat.id));

      await settleChatOwnedFlowDeletion(attemptDelete, cancelFlowRunForChatDeletion);

      expect(attemptDelete).toHaveBeenCalledTimes(2);
      expect(await getChatById(db, chat.id)).toBeNull();
      expect(await getTaskById(db, task.id)).toBeNull();
      expect(await getTaskById(db, unclaimed.id)).toBeNull();
      expect(await runStatus()).toBe('failed');
      expect(cancelledEvents).toEqual([]);
    },
  );

  it('deletes a project whose chats share a failed run, sparing a chat outside it', async () => {
    const project = await createProject(db, { name: 'P2', path: '/tmp/p2' });
    const first = await createChat(db, { name: 'A', projectId: project.id });
    const second = await createChat(db, { name: 'B', projectId: project.id });
    const outside = await createChat(db, { name: 'O' });
    const firstTask = await parkedTask(first.id);
    const secondTask = await parkedTask(second.id);
    const outsideTask = await parkedTask(outside.id);
    await setFlowRunStatus(db, flowRunId, 'failed');

    await settleChatOwnedFlowDeletion(
      () => deleteProject(db, project.id),
      cancelFlowRunForChatDeletion,
    );

    expect(await getProjectById(db, project.id)).toBeNull();
    expect(await getTaskById(db, firstTask.id)).toBeNull();
    expect(await getTaskById(db, secondTask.id)).toBeNull();
    expect(await getChatById(db, outside.id)).not.toBeNull();
    expect((await getTaskById(db, outsideTask.id))?.status).toBe('needs_attention');
    expect(await runStatus()).toBe('failed');
  });

  it('settles two overlapping deletes of the same chat on a failed run', async () => {
    const chat = await createChat(db, { name: 'C' });
    const sibling = await createChat(db, { name: 'S' });
    const task = await parkedTask(chat.id);
    const siblingTask = await parkedTask(sibling.id);
    await setFlowRunStatus(db, flowRunId, 'failed');
    const remove = () =>
      settleChatOwnedFlowDeletion(
        () => deleteChatWithFlowQueueTasks(db, chat.id),
        cancelFlowRunForChatDeletion,
      );

    await expect(Promise.all([remove(), remove()])).resolves.toBeDefined();

    expect(await getChatById(db, chat.id)).toBeNull();
    expect(await getTaskById(db, task.id)).toBeNull();
    expect((await getTaskById(db, siblingTask.id))?.status).toBe('needs_attention');
  });

  it('aborts a live node on flow hard delete, and a later dispatch into the run declines', async () => {
    const ctx = await loadRunContext(flowRunId);
    if (!ctx) throw new Error('no run context');
    seedActiveAdmission(db, flowRunId);
    const fence = readRunFence(db, flowRunId) as RunFence;
    const node = new AbortController();
    // Registered after the Cancel commits, so only the hard delete's own abort can reach it.
    const stop = subscribeFlowEvents((event) => {
      if (event.eventType === 'run_cancelled') registerNodeAbort(flowRunId, node);
    });

    await expect(deleteFlow(flowId)).resolves.toBe(true);
    stop();

    expect(node.signal.aborted).toBe(true);
    expect(await getFlowRun(db, flowRunId)).toBeNull();
    await dispatchAndAdvance(fence, GRAPH.nodes[0], undefined, ctx);
    expect(await listNodeRunsForFlowRun(db, flowRunId)).toEqual([]);
    expect(dispatchNode).not.toHaveBeenCalled();
    expect(cancelledEvents).toHaveLength(1);
  });
});
