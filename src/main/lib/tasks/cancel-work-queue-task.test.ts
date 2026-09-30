import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  capture: vi.fn(),
  abortSessions: vi.fn(),
  resolveTarget: vi.fn(),
  resolveSeed: vi.fn(),
}));

vi.mock('../db', async (original) => ({
  ...(await original<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../sentry/init', () => ({ captureMainException: holder.capture }));
vi.mock('../sentry', () => ({ captureContained: holder.capture }));
vi.mock('../flows/dispatch', () => ({ dispatchNode: vi.fn() }));
vi.mock('../socket/executor', () => ({ abortActiveExecutionsForSubChats: holder.abortSessions }));
// The typed-reply conversion gate reads the chat's session; these tests only need its verdict.
vi.mock('../flows/admission/terminal-resume/dispatcher', async (original) => ({
  ...(await original<typeof import('../flows/admission/terminal-resume/dispatcher')>()),
  resolveTerminalResumeTarget: holder.resolveTarget,
}));
vi.mock('../flows/rerun/session-resume', () => ({ resolveSessionResumeSeed: holder.resolveSeed }));

import { type FlowExecutionEvent, RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import { createTask, getTaskById, type TaskStatus, updateTaskStatus } from '../db/repos/tasks';
import { flowRunAdmissions } from '../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { hasFlowResourceActivity } from '../flows/admission/activity';
import type { FlowAdmissionConfig } from '../flows/admission/config';
import {
  _resetFlowAdmissionControllerMutexForTests,
  FlowAdmissionController,
} from '../flows/admission/controller';
import { _setFlowAdmissionControllerForTests } from '../flows/admission/runtime';
import { stageContinuationResume } from '../flows/admission/terminal-resume/continuation';
import { ResumeAdmitDeclinedError } from '../flows/admission/terminal-resume/resume-store';
import { registerNodeAbort } from '../flows/cancel-registry';
import { subscribeFlowEvents } from '../flows/events';
import { rerunFlowRunFromInterruption } from '../flows/resume';
import { cancelWorkQueueRunCommand, isRestartInterrupted } from '../flows/transitions';
import { registerFlowProviderExecution } from '../socket/execution/flow-resource-cleanup';
import { cancelWorkQueueTask } from './cancel-work-queue-task';

const GRAPH = {
  nodes: [
    { id: 'work', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } },
  ],
  edges: [],
};
const MARKED_OUTPUT = {
  status: 'cancelled',
  outputs: {},
  artifacts: [],
  durationMs: 1,
  error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
};

let db: TestDb;
let controller: FlowAdmissionController;
let flowRunId: string;
let cancelledEvents: FlowExecutionEvent[];
let unsubscribe: () => void;

beforeEach(async () => {
  _resetFlowAdmissionControllerMutexForTests();
  vi.clearAllMocks();
  db = freshDb();
  holder.db = db;
  // Paused, so an enqueued resume stays queued where the test can see it.
  const config: FlowAdmissionConfig = {
    version: 1,
    queuePaused: true,
    concurrencyLimitEnabled: false,
    maxConcurrentRuns: 4,
  };
  controller = new FlowAdmissionController(db, async () => config);
  _setFlowAdmissionControllerForTests(controller);
  ({ flowRunId } = await seedFlowRun(db, GRAPH));
  cancelledEvents = [];
  unsubscribe = subscribeFlowEvents((event) => {
    if (event.eventType === 'run_cancelled') cancelledEvents.push(event);
  });
});

afterEach(() => {
  unsubscribe();
  _setFlowAdmissionControllerForTests(null);
});

const status = async (taskId: string) => (await getTaskById(db, taskId))?.status;
const liveTickets = () =>
  db
    .select()
    .from(flowRunAdmissions)
    .where(eq(flowRunAdmissions.flowRunId, flowRunId))
    .all()
    .filter((row) => ['queued', 'claimed', 'active', 'releasing'].includes(row.state));

async function flowTask(taskStatus: TaskStatus, result: Record<string, unknown> = {}) {
  const task = await createTask(db, { description: 'step', source: 'flow', flowRunId });
  if (taskStatus !== 'pending') await updateTaskStatus(db, task.id, taskStatus, { result });
  return task;
}

/** A run a restart cancelled: its node and driving task carry the marker. */
async function interruptedRun() {
  const node = await createNodeRun(db, { flowRunId, nodeId: 'work', blockType: 'agent' });
  await setNodeRunStatus(db, node.id, 'cancelled', { nodeOutput: MARKED_OUTPUT });
  const task = await flowTask('cancelled', {
    subChatId: 'sub-1',
    cancelled: true,
    error: RESTART_INTERRUPTION_REASON,
  });
  await setFlowRunStatus(db, flowRunId, 'cancelled');
  return { node, task };
}

async function failedRun() {
  const node = await createNodeRun(db, { flowRunId, nodeId: 'work', blockType: 'agent' });
  await setNodeRunStatus(db, node.id, 'failed', {});
  const task = await flowTask('needs_attention', { subChatId: 'sub-1' });
  await setFlowRunStatus(db, flowRunId, 'failed');
  return { node, task };
}

describe('cancelWorkQueueTask', () => {
  it('flips a manual row and stops its running session', async () => {
    const task = await createTask(db, { description: 'manual', source: 'manual' });
    await updateTaskStatus(db, task.id, 'running', { result: { subChatId: 'sub-m' } });

    expect((await cancelWorkQueueTask(db, task.id)).task?.status).toBe('cancelled');
    expect(holder.abortSessions).toHaveBeenCalledWith(['sub-m'], 'task cancelled');
    expect(await cancelWorkQueueTask(db, task.id)).toEqual({
      task: null,
      reason: 'invalid_state',
    });
    expect(await cancelWorkQueueTask(db, 'missing')).toEqual({ task: null, reason: 'not_found' });
  });

  it('cancels a live run from a parked row, stopping running work and keeping parked siblings', async () => {
    const ticket = seedActiveAdmission(db, flowRunId);
    const clicked = await flowTask('needs_attention');
    const running = await flowTask('running', { subChatId: 'sub-run' });
    const parked = await flowTask('needs_attention');
    const node = new AbortController();
    registerNodeAbort(flowRunId, node);

    const result = await cancelWorkQueueTask(db, clicked.id);

    expect(result.task).toMatchObject({ id: clicked.id, status: 'cancelled' });
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect(await status(running.id)).toBe('cancelled');
    expect(await status(parked.id)).toBe('needs_attention');
    expect(node.signal.aborted).toBe(true);
    expect(holder.abortSessions).toHaveBeenCalledWith(['sub-run'], 'task cancelled');
    expect(liveTickets().map((row) => row.ticket)).not.toContain(ticket);
    expect(cancelledEvents).toHaveLength(1);
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('cancels a live run from its done row and returns that row unchanged', async () => {
    seedActiveAdmission(db, flowRunId);
    const done = await flowTask('done');

    expect((await cancelWorkQueueTask(db, done.id)).task).toMatchObject({ status: 'done' });
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect(cancelledEvents).toHaveLength(1);
  });

  it('clears an interrupted run and drops its queued Re-run', async () => {
    const { node, task } = await interruptedRun();
    await controller.enqueueTerminalResume({ flowRunId, nodeRunId: node.id });

    expect((await cancelWorkQueueTask(db, task.id)).task).toMatchObject({
      id: task.id,
      status: 'cancelled',
      result: { subChatId: 'sub-1', cancelled: true },
    });
    expect(isRestartInterrupted(db, flowRunId)).toBe(false);
    expect(liveTickets()).toEqual([]);
    expect(cancelledEvents).toHaveLength(0);
  });

  it("keeps a failed run's queued Retry when its row is cancelled", async () => {
    const { node, task } = await failedRun();
    await controller.enqueueTerminalResume({ flowRunId, nodeRunId: node.id });

    expect((await cancelWorkQueueTask(db, task.id)).task).toMatchObject({ status: 'cancelled' });
    expect(liveTickets()).toHaveLength(1);
  });

  it('clears a restart marker left on a live run it cancels', async () => {
    seedActiveAdmission(db, flowRunId);
    const marked = await flowTask('cancelled', { error: RESTART_INTERRUPTION_REASON });
    const clicked = await flowTask('needs_attention');

    const markerOf = async () =>
      ((await getTaskById(db, marked.id))?.result as { error?: string } | null)?.error;
    expect(await markerOf()).toBe(RESTART_INTERRUPTION_REASON);

    await cancelWorkQueueTask(db, clicked.id);

    expect(await markerOf()).toBeUndefined();
  });

  it("stops a terminal run's stray running row once", async () => {
    await failedRun();
    const stray = await flowTask('running', { subChatId: 'sub-stray' });

    expect((await cancelWorkQueueTask(db, stray.id)).task).toMatchObject({ status: 'cancelled' });
    expect(holder.abortSessions).toHaveBeenCalledOnce();
    expect(holder.abortSessions).toHaveBeenCalledWith(['sub-stray'], 'task cancelled');
  });

  it('writes and aborts nothing for a finished run with nothing to cancel', async () => {
    await setFlowRunStatus(db, flowRunId, 'completed');
    const done = await flowTask('done');
    const node = new AbortController();
    registerNodeAbort(flowRunId, node);

    expect(await cancelWorkQueueTask(db, done.id)).toEqual({
      task: null,
      reason: 'invalid_state',
    });
    expect(node.signal.aborted).toBe(false);
  });
});

/** A send into the run: its preflight declines and records a continuation (typed-reply v1). */
async function sendTurn(canonicalTaskId: string) {
  const registration = await registerFlowProviderExecution({
    provenance: {
      prefetchedSignalTask: { id: canonicalTaskId, source: 'flow', flowRunId, status: 'cancelled' },
      taskSignalDisarmed: false,
      provenanceLookupError: null,
      restartInterruptedFlowRunId: null,
    },
    controller: new AbortController(),
    chatId: 'chat-1',
  });
  if (!registration) throw new Error('turn was not registered');
  const decline = (await registration.prepareAndValidate(async () => {}).catch((e) => e)) as {
    category?: string;
  };
  expect(decline.category).toBe('FLOW_RUN_RESUMING');
  return registration;
}

/** The executor's finally: stage what the turn recorded, then settle its activity. */
async function settleTurn(
  registration: Awaited<ReturnType<typeof sendTurn>>,
  emitCorrective = vi.fn(),
  watch = {},
) {
  const pending = registration.takePendingContinuationResume();
  if (pending) stageContinuationResume(pending, emitCorrective, watch);
  registration.unregisterAbort();
  registration.release();
  await vi.waitFor(() => expect(hasFlowResourceActivity(flowRunId)).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const resumeTickets = () =>
  db
    .select()
    .from(flowRunAdmissions)
    .where(and(eq(flowRunAdmissions.flowRunId, flowRunId), eq(flowRunAdmissions.state, 'queued')))
    .all();

async function seedTypedReplyTarget(seedRun: typeof interruptedRun) {
  const { node, task } = await seedRun();
  holder.resolveTarget.mockResolvedValue({ node: { id: 'work' }, nodeRunId: node.id });
  holder.resolveSeed.mockResolvedValue({ config: { resumeSession: true } });
  return task.id;
}

describe.each([
  ['interrupted', interruptedRun],
  ['failed', failedRun],
])('a Cancel against a typed reply into a %s run', (_, seedRun) => {
  let taskId: string;
  beforeEach(async () => {
    taskId = await seedTypedReplyTarget(seedRun);
  });

  it('drops a continuation recorded before the Cancel', async () => {
    const turn = await sendTurn(taskId);
    await cancelWorkQueueTask(db, taskId);
    await settleTurn(turn);

    expect(resumeTickets()).toEqual([]);
  });

  it('drops a continuation staged before the Cancel', async () => {
    const turn = await sendTurn(taskId);
    const pending = turn.takePendingContinuationResume();
    if (pending) stageContinuationResume(pending, vi.fn());
    await cancelWorkQueueTask(db, taskId);
    await settleTurn(turn);

    expect(resumeTickets()).toEqual([]);
  });

  it('drops a continuation the fire path already read when the Cancel lands', async () => {
    const turn = await sendTurn(taskId);
    const enqueue = controller.enqueueTerminalResume.bind(controller);
    const spy = vi.spyOn(controller, 'enqueueTerminalResume').mockImplementation(async (input) => {
      await cancelWorkQueueTask(db, taskId);
      return enqueue(input);
    });
    await settleTurn(turn);

    expect(spy).toHaveBeenCalledOnce();
    expect(resumeTickets()).toEqual([]);
  });

  it('drops a continuation the settle path already read when the Cancel lands', async () => {
    seedActiveAdmission(db, flowRunId);
    const turn = await sendTurn(taskId);
    const settle = controller.settleWithContinuation.bind(controller);
    let settled: ReturnType<typeof settle> | undefined;
    const spy = vi.spyOn(controller, 'settleWithContinuation').mockImplementation((...args) => {
      settled = cancelWorkQueueTask(db, taskId).then(() => settle(...args));
      return settled;
    });
    await settleTurn(turn);
    await vi.waitFor(() => expect(settled).toBeDefined());
    await settled;

    expect(spy).toHaveBeenCalledOnce();
    expect(resumeTickets()).toEqual([]);
  });

  // Residual until a queued note can be told from a typed reply (sc-4178).
  it('still converts a send registered after the Cancel into one resume', async () => {
    await cancelWorkQueueTask(db, taskId);
    await settleTurn(await sendTurn(taskId));

    expect(resumeTickets()).toHaveLength(1);
  });
});

const FAST_WATCH = { intervalMs: 5, attempts: 3 };

describe('a Cancel after an interrupted run enqueued its continuation', () => {
  let taskId: string;
  beforeEach(async () => {
    taskId = await seedTypedReplyTarget(interruptedRun);
  });

  it('ends the queued continuation without an error report or corrective', async () => {
    const emitCorrective = vi.fn();
    await settleTurn(await sendTurn(taskId), emitCorrective, FAST_WATCH);
    expect(resumeTickets()).toHaveLength(1);

    await cancelWorkQueueTask(db, taskId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(resumeTickets()).toEqual([]);
    expect(emitCorrective).not.toHaveBeenCalled();
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('ends a continuation cancelled during its post-enqueue drain quietly', async () => {
    const getByTicket = controller.getByTicket.bind(controller);
    vi.spyOn(controller, 'getByTicket').mockImplementationOnce(async (ticket) => {
      await cancelWorkQueueTask(db, taskId);
      return getByTicket(ticket);
    });
    const emitCorrective = vi.fn();
    await settleTurn(await sendTurn(taskId), emitCorrective, FAST_WATCH);

    expect(isRestartInterrupted(db, flowRunId)).toBe(false);
    expect(resumeTickets()).toEqual([]);
    expect(emitCorrective).not.toHaveBeenCalled();
    expect(holder.capture).not.toHaveBeenCalled();
  });
});

it("keeps a failed run's enqueued continuation when its row is cancelled", async () => {
  const taskId = await seedTypedReplyTarget(failedRun);
  const emitCorrective = vi.fn();
  await settleTurn(await sendTurn(taskId), emitCorrective, FAST_WATCH);
  expect(resumeTickets()).toHaveLength(1);

  await cancelWorkQueueTask(db, taskId);

  expect(resumeTickets()).toHaveLength(1);
  expect(emitCorrective).not.toHaveBeenCalled();
  expect(holder.capture).not.toHaveBeenCalled();
});

describe('Re-run step against a Work Queue Cancel', () => {
  it('declines the enqueue once the Cancel cleared the marker first', async () => {
    const { task } = await interruptedRun();
    const enqueue = controller.enqueueTerminalResume.bind(controller);
    vi.spyOn(controller, 'enqueueTerminalResume').mockImplementation(async (input) => {
      db.transaction(() => cancelWorkQueueRunCommand(db, flowRunId, task.id));
      return enqueue(input);
    });

    const error = await rerunFlowRunFromInterruption(flowRunId).catch((e) => e);

    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(error.cause).toBeInstanceOf(ResumeAdmitDeclinedError);
    expect(liveTickets()).toEqual([]);
  });

  it('reports a Cancel that drops the enqueued ticket as the user cancelling', async () => {
    const { task } = await interruptedRun();
    const getByTicket = controller.getByTicket.bind(controller);
    vi.spyOn(controller, 'getByTicket').mockImplementationOnce(async (ticket) => {
      await cancelWorkQueueTask(db, task.id);
      return getByTicket(ticket);
    });

    const error = await rerunFlowRunFromInterruption(flowRunId).catch((e) => e);

    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(error.message).toMatch(/cancelled by the user/i);
    expect(liveTickets()).toEqual([]);
  });
});
