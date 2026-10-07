import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FlowExecutionEvent,
  type NodeOutput,
  RESTART_INTERRUPTION_REASON,
} from '../../../shared/types/flow';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import { createTask, getTaskById, parseResultRecord, updateTaskStatus } from '../db/repos/tasks';
import { chats, flowRunAdmissions, subChatMessages, subChats, tasks } from '../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  capture: vi.fn(),
  afterRunRead: null as null | (() => unknown),
}));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
// Runs `afterRunRead` once, right after the next getFlowRun resolves: a commit parked mid-read.
vi.mock('../db/repos/flow-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repos/flow-runs')>();
  return {
    ...actual,
    getFlowRun: async (...args: Parameters<typeof actual.getFlowRun>) => {
      const run = await actual.getFlowRun(...args);
      const hook = holder.afterRunRead;
      holder.afterRunRead = null;
      await hook?.();
      return run;
    },
  };
});
vi.mock('../socket/executor', () => ({ abortActiveExecutionsForSubChats: vi.fn() }));
vi.mock('../sentry/init', () => ({
  captureMainException: holder.capture,
  captureMainMessage: holder.capture,
}));
vi.mock('../flows/task-completion-watcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flows/task-completion-watcher')>();
  return { ...actual, forgetAdvancedTask: vi.fn(actual.forgetAdvancedTask) };
});

import { FlowAdmissionController } from '../flows/admission/controller';
import {
  _setFlowAdmissionControllerForTests,
  recoverFlowAdmissions,
} from '../flows/admission/runtime';
import { cancelFlowRun } from '../flows/engine';
import { subscribeFlowEvents } from '../flows/events';
import { forgetAdvancedTask } from '../flows/task-completion-watcher';
import {
  isRestartInterrupted,
  reviveInPlaceCommand,
  unparkFailedRunCommand,
} from '../flows/transitions';
import { cancelWorkQueueTask } from './cancel-work-queue-task';
import { reviveRestartInterruptedFlow } from './revive-interrupted-flow';

const GRAPH = {
  nodes: [{ id: 'a', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } }],
  edges: [],
};
const MARKED_OUTPUT: NodeOutput = {
  status: 'cancelled',
  outputs: {},
  artifacts: [],
  durationMs: 0,
  error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
};
/** The result a restart cancel merges onto the task, stale markers of the ended attempt and all. */
const CANCELLED_RESULT = {
  cancelled: true,
  error: RESTART_INTERRUPTION_REASON,
  subChatId: 'sub-1',
  userPause: { at: '2026-07-14T00:00:00Z' },
  agentSignal: { state: 'awaiting_input', summary: 'stale ask' },
};

let db: TestDb;
let flowRunId: string;
let nodeRunId: string;
let taskId: string;
let ticket: number;
let controller: FlowAdmissionController;

/** The shape a restart leaves (run, node, task cancelled; marker on the node; slot active). `answered`
 * seeds the task's prompt and the session's reply; false models a prompt never sent. */
async function seedInterruptedRun(
  nodeOutput: NodeOutput = MARKED_OUTPUT,
  answered = true,
): Promise<void> {
  ({ flowRunId } = await seedFlowRun(db, GRAPH));
  ticket = seedActiveAdmission(db, flowRunId);
  nodeRunId = (await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' })).id;
  await setNodeRunStatus(db, nodeRunId, 'cancelled', { nodeOutput, completedAt: new Date() });
  await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
  const task = await createTask(db, {
    description: 'agent',
    source: 'flow',
    sourceId: nodeRunId,
    flowRunId,
    nodeRunId,
  });
  taskId = task.id;
  await updateTaskStatus(db, taskId, 'cancelled', { result: CANCELLED_RESULT });
  await db.insert(chats).values({ id: 'chat-1' });
  await db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'session-1' });
  const prompt = { id: 'u1', role: 'user', parts: [], metadata: { dispatchTaskId: taskId } };
  const reply = { id: 'a1', role: 'assistant', parts: [] };
  await db
    .insert(subChatMessages)
    .values([
      { subChatId: 'sub-1', seq: 0, message: JSON.stringify(prompt) },
      ...(answered ? [{ subChatId: 'sub-1', seq: 1, message: JSON.stringify(reply) }] : []),
    ]);
}

const statuses = async () => ({
  run: (await getFlowRun(db, flowRunId))?.status,
  node: (await getNodeRun(db, nodeRunId))?.status,
  task: (await getTaskById(db, taskId))?.status,
});
const slotState = () =>
  db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, ticket)).get()?.state;

beforeEach(() => {
  db = freshDb();
  holder.db = db;
  holder.capture.mockReset();
  holder.afterRunRead = null;
  vi.mocked(forgetAdvancedTask).mockClear();
  controller = new FlowAdmissionController(db, async () => ({
    version: 1,
    queuePaused: false,
    concurrencyLimitEnabled: false,
    maxConcurrentRuns: 4,
  }));
  _setFlowAdmissionControllerForTests(controller);
});

afterEach(() => _setFlowAdmissionControllerForTests(null));

describe('reviveRestartInterruptedFlow', () => {
  it('revives task, marked node and run together, scrubbing the ended attempt’s markers', async () => {
    await seedInterruptedRun();

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'running', node: 'running', task: 'running' });
    expect(forgetAdvancedTask).toHaveBeenCalledWith(taskId);
    expect((await getNodeRun(db, nodeRunId))?.nodeOutput).toBeNull();
    const result = parseResultRecord((await getTaskById(db, taskId))?.result ?? null);
    expect(result).toMatchObject({
      subChatId: 'sub-1',
      resumedBy: 'follow_up_message',
      previousStatus: 'cancelled',
    });
    for (const marker of ['cancelled', 'error', 'userPause', 'agentSignal']) {
      expect(result).not.toHaveProperty(marker);
    }
  });

  // The app died between dispatching this node and sending its prompt: the shared session only ever
  // answered an earlier node, so a follow-up must not let this node complete unrun.
  it("writes nothing when the session never answered the task's node", async () => {
    await seedInterruptedRun(MARKED_OUTPUT, false);

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
  });

  // The session answered the node's earlier attempt; this attempt's prompt was sent, never answered.
  it('writes nothing when only an earlier attempt of the node was answered', async () => {
    await seedInterruptedRun(MARKED_OUTPUT, false);
    const earlier = await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' });
    const first = await createTask(db, {
      description: 'agent',
      source: 'flow',
      sourceId: earlier.id,
      flowRunId,
      nodeRunId: earlier.id,
    });
    const prompt = { id: 'u0', role: 'user', parts: [], metadata: { dispatchTaskId: first.id } };
    await db.insert(subChatMessages).values([
      { subChatId: 'sub-1', seq: -2, message: JSON.stringify(prompt) },
      { subChatId: 'sub-1', seq: -1, message: '{"id":"a0","role":"assistant","parts":[]}' },
    ]);

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
  });

  // Continuing in place skips re-admission, so a slot that already began releasing (a settle, or a
  // teardown cleanup error) must decline and leave the run on the Re-run path.
  it('writes nothing once the slot is no longer active', async () => {
    await seedInterruptedRun();
    db.update(flowRunAdmissions)
      .set({ state: 'releasing', error: 'cleanup failed' })
      .where(eq(flowRunAdmissions.ticket, ticket))
      .run();

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
    expect((await getNodeRun(db, nodeRunId))?.nodeOutput).toEqual(MARKED_OUTPUT);
    expect(parseResultRecord((await getTaskById(db, taskId))?.result ?? null)).toEqual(
      CANCELLED_RESULT,
    );
  });

  it('never revives a run the user cancelled (no restart marker)', async () => {
    await seedInterruptedRun({ ...MARKED_OUTPUT, error: undefined });

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
    expect(forgetAdvancedTask).not.toHaveBeenCalled();
  });

  it('writes nothing once the driving task left cancelled', async () => {
    await seedInterruptedRun();
    db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId)).run();

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'done' });
  });

  it('never revives a marked node on a run that is not cancelled', async () => {
    await seedInterruptedRun();
    await setFlowRunStatus(db, flowRunId, 'failed');

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'failed', node: 'cancelled', task: 'cancelled' });
  });

  it('a second revive (double message) writes nothing over the first', async () => {
    await seedInterruptedRun();
    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');
    const first = await getTaskById(db, taskId);

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await getTaskById(db, taskId)).toEqual(first);
    expect(await statuses()).toEqual({ run: 'running', node: 'running', task: 'running' });
  });

  describe('against a terminal release deciding on a stale run read', () => {
    /** Commits `reopen` right after the release's run read, then runs boot recovery's reconcile. */
    async function reconcileAround(reopen: () => unknown): Promise<void> {
      let fired = false;
      holder.afterRunRead = () => {
        fired = true;
        return db.transaction(() => reopen());
      };
      await recoverFlowAdmissions();
      expect(fired).toBe(true);
    }

    it('a revive that commits while the release is deciding keeps its slot', async () => {
      await seedInterruptedRun();

      await reconcileAround(() => reviveInPlaceCommand(db, taskId, flowRunId));

      expect(await statuses()).toEqual({ run: 'running', node: 'running', task: 'running' });
      expect(slotState()).toBe('active');
    });

    it('a failed-run Retry that commits while the release is deciding keeps its slot', async () => {
      await seedInterruptedRun();
      await setNodeRunStatus(db, nodeRunId, 'failed', { nodeOutput: null });
      await setFlowRunStatus(db, flowRunId, 'failed');

      await reconcileAround(() => unparkFailedRunCommand(db, flowRunId));

      expect(await statuses()).toMatchObject({ run: 'running', node: 'running' });
      expect(slotState()).toBe('active');
    });
  });

  describe('against Cancel', () => {
    let cancelled: FlowExecutionEvent[];
    let started: FlowExecutionEvent[];
    let unsubscribe: () => void;
    beforeEach(() => {
      cancelled = [];
      started = [];
      unsubscribe = subscribeFlowEvents((event) => {
        if (event.eventType === 'run_cancelled') cancelled.push(event);
        if (event.eventType === 'run_started' || event.eventType === 'node_started') {
          started.push(event);
        }
      });
    });
    afterEach(() => unsubscribe());

    it('a Stop that commits inside the revive’s context load leaves no started events', async () => {
      await seedInterruptedRun();
      const transition = controller.transition.bind(controller);
      vi.spyOn(controller, 'transition').mockImplementationOnce(async (command, afterCommit) => {
        const result = await transition(command, afterCommit);
        // The next run read is loadRunContext's, after the revive committed.
        holder.afterRunRead = () => cancelFlowRun(flowRunId);
        return result;
      });

      await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

      expect(holder.afterRunRead).toBeNull();
      expect(started).toEqual([]);
      expect(cancelled).toHaveLength(1);
      expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
    });

    it('a Stop after the revive commits cancels the revived run once and releases its slot', async () => {
      await seedInterruptedRun();
      await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

      await cancelFlowRun(flowRunId);

      expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
      expect(cancelled).toHaveLength(1);
      const slot = db
        .select()
        .from(flowRunAdmissions)
        .where(eq(flowRunAdmissions.ticket, ticket))
        .get();
      expect(slot?.state).not.toBe('active');
      expect(holder.capture).not.toHaveBeenCalled();
    });

    // Pins the marker clear only: this Cancel still leaves the slot active (sc-4206).
    it('a revive after a Work Queue Cancel cleared the restart marker writes nothing', async () => {
      await seedInterruptedRun();
      await cancelWorkQueueTask(db, taskId);
      expect(isRestartInterrupted(db, flowRunId)).toBe(false);

      await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

      expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
      expect(forgetAdvancedTask).not.toHaveBeenCalled();
      expect(started).toEqual([]);
    });

    it('a Work Queue Cancel after a committed revive wins', async () => {
      await seedInterruptedRun();
      await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');
      expect((await statuses()).run).toBe('running');

      await cancelWorkQueueTask(db, taskId);

      expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
      expect(cancelled).toHaveLength(1);
      expect(slotState()).not.toBe('active');
      expect(holder.capture).not.toHaveBeenCalled();
    });
  });
});
