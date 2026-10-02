import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowExecutionEvent } from '../../../shared/types/flow';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import { createTask, getTaskById, updateTaskStatus } from '../db/repos/tasks';
import type { Task } from '../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({ db: null as unknown, capture: vi.fn() }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../socket/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../socket/client')>()),
  broadcastTaskSignalPersisted: vi.fn(),
}));
vi.mock('../sentry/init', () => ({
  captureMainException: holder.capture,
  captureMainMessage: holder.capture,
}));

import { FlowAdmissionController } from '../flows/admission/controller';
import { _setFlowAdmissionControllerForTests } from '../flows/admission/runtime';
import { cancelFlowRun } from '../flows/engine';
import { resumeFlowRun } from '../flows/resume';
import { persistLinkedTaskSignal } from '../trpc/routers/frink-task-signal-persist';
import { resolveTaskSignalTransition } from '../trpc/routers/frink-task-signal';
import { subscribeFlowEvents } from '../flows/events';
import { resumeParkedTaskInPlace } from './resume-parked-task';

const GRAPH = {
  nodes: [{ id: 'a', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } }],
  edges: [],
};
const QUIET_PARK = { agentSignal: { state: 'missing_completion_signal', summary: 'quiet' } };

let db: TestDb;
let controller: FlowAdmissionController;
let flowRunId: string;
let nodeRunId: string;
let cancelled: FlowExecutionEvent[];
let unsubscribe: () => void;

/** A task parked with its node and run, as the watcher leaves them; `slot` seeds an active admission. */
async function seedParkedTask(
  status: 'needs_attention' | 'failed' | 'plan_ready',
  { slot = true, result = QUIET_PARK as Record<string, unknown> } = {},
): Promise<Task> {
  ({ flowRunId } = await seedFlowRun(db, GRAPH));
  if (slot) seedActiveAdmission(db, flowRunId);
  nodeRunId = (await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' })).id;
  const task = await createTask(db, { description: 'agent', source: 'flow', flowRunId, nodeRunId });
  await updateTaskStatus(db, task.id, 'running');
  const parked = await updateTaskStatus(db, task.id, status, { result });
  const nodeStatus = status === 'failed' ? 'failed' : 'awaiting_input';
  await setNodeRunStatus(db, nodeRunId, nodeStatus, { completedAt: new Date() });
  await setFlowRunStatus(db, flowRunId, status === 'failed' ? 'failed' : 'paused');
  if (!parked) throw new Error('park failed');
  return parked;
}

const statuses = async (taskId: string) => ({
  run: (await getFlowRun(db, flowRunId))?.status,
  node: (await getNodeRun(db, nodeRunId))?.status,
  task: (await getTaskById(db, taskId))?.status,
});

beforeEach(() => {
  db = freshDb();
  holder.db = db;
  holder.capture.mockReset();
  controller = new FlowAdmissionController(db, async () => ({
    version: 1,
    queuePaused: false,
    concurrencyLimitEnabled: false,
    maxConcurrentRuns: 4,
  }));
  _setFlowAdmissionControllerForTests(controller);
  cancelled = [];
  unsubscribe = subscribeFlowEvents((event) => {
    if (event.eventType === 'run_cancelled') cancelled.push(event);
  });
});

afterEach(() => {
  unsubscribe();
  _setFlowAdmissionControllerForTests(null);
});

describe('resumeParkedTaskInPlace — follow-up message', () => {
  it('resumes a flow-less parked task without the admission mutex', async () => {
    const task = await createTask(db, { description: 'manual', source: 'manual' });
    await updateTaskStatus(db, task.id, 'running');
    const parked = await updateTaskStatus(db, task.id, 'needs_attention');
    if (!parked) throw new Error('park failed');
    const transition = vi.spyOn(controller, 'transition');

    expect(await resumeParkedTaskInPlace(parked, 'follow_up_message', 'sub-1')).toBe(true);
    expect((await getTaskById(db, task.id))?.status).toBe('running');
    expect(transition).not.toHaveBeenCalled();
    expect(holder.capture).not.toHaveBeenCalled();
  });

  it('resumes the task, its parked node and its paused run together', async () => {
    const task = await seedParkedTask('needs_attention');

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(true);
    expect(await statuses(task.id)).toEqual({ run: 'running', node: 'running', task: 'running' });
  });

  it('revives a failed run through its last unfinished node', async () => {
    const task = await seedParkedTask('failed');

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(true);
    expect(await statuses(task.id)).toEqual({ run: 'running', node: 'running', task: 'running' });
  });

  it('scrubs the ended attempt’s markers but keeps linkage and start mode', async () => {
    const task = await seedParkedTask('needs_attention', {
      result: {
        subChatId: 'sub-1',
        startMode: 'plan',
        usageLimit: { message: 'limit', at: '2026-06-10' },
        agentSignal: { state: 'awaiting_input', summary: 'Which branch?' },
        error: 'old',
        failureCode: 'EXECUTION_LEASE_EXPIRED',
        staleExecution: true,
      },
    });

    await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1');

    expect((await getTaskById(db, task.id))?.result).toEqual({
      subChatId: 'sub-1',
      startMode: 'plan',
      resumedBy: 'follow_up_message',
      resumedAt: expect.any(String),
      previousStatus: 'needs_attention',
    });
  });

  it('writes nothing once the task left its park', async () => {
    const task = await seedParkedTask('needs_attention');
    await updateTaskStatus(db, task.id, 'done');

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(false);
    expect(await statuses(task.id)).toEqual({
      run: 'paused',
      node: 'awaiting_input',
      task: 'done',
    });
  });

  it('keeps the task running and reports it when the flow cannot follow', async () => {
    const task = await seedParkedTask('needs_attention', { slot: false });

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(false);
    expect(await statuses(task.id)).toEqual({
      run: 'paused',
      node: 'awaiting_input',
      task: 'running',
    });
    expect(holder.capture).toHaveBeenCalledWith(
      'Task resumed but its flow did not follow',
      'warning',
      expect.objectContaining({ taskId: task.id }),
    );
  });
  it('reports a failed resume and writes nothing', async () => {
    const task = await seedParkedTask('needs_attention');
    holder.db = new Proxy(
      {},
      {
        get: () => {
          throw new Error('db down');
        },
      },
    );

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(false);
    expect(holder.capture).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'resume-parked-task',
      resumedBy: 'follow_up_message',
    });
    expect(await statuses(task.id)).toEqual({
      run: 'paused',
      node: 'awaiting_input',
      task: 'needs_attention',
    });
  });
});

describe('resumeParkedTaskInPlace — wake burst', () => {
  it('writes nothing when the flow cannot follow', async () => {
    const task = await seedParkedTask('needs_attention', { slot: false });

    expect(await resumeParkedTaskInPlace(task, 'wake_burst', 'sub-1')).toBe(false);
    expect(await getTaskById(db, task.id)).toEqual(task);
    expect(await statuses(task.id)).toEqual({
      run: 'paused',
      node: 'awaiting_input',
      task: 'needs_attention',
    });
  });

  it('a Cancel after the wake commits cancels task, node and run once', async () => {
    const task = await seedParkedTask('needs_attention');
    expect(await resumeParkedTaskInPlace(task, 'wake_burst', 'sub-1')).toBe(true);

    await cancelFlowRun(flowRunId);

    expect(await statuses(task.id)).toEqual({
      run: 'cancelled',
      node: 'cancelled',
      task: 'cancelled',
    });
    expect(cancelled).toHaveLength(1);
  });

  it('a wake after the Cancel leaves no half-resumed state', async () => {
    const task = await seedParkedTask('needs_attention');
    await cancelFlowRun(flowRunId);

    expect(await resumeParkedTaskInPlace(task, 'wake_burst', 'sub-1')).toBe(false);
    expect(await getTaskById(db, task.id)).toEqual(task);
    expect(await statuses(task.id)).toEqual({
      run: 'cancelled',
      node: 'cancelled',
      task: 'needs_attention',
    });
    expect(cancelled).toHaveLength(1);
  });
});

describe('resumeParkedTaskInPlace — chat reply approving a strict plan park', () => {
  const PLAN_PARK = { subChatId: 'sub-1', startMode: 'plan', skipReview: false };

  it('resumes the task in execute mode with its node and run', async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK });

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(true);
    expect(await statuses(task.id)).toEqual({ run: 'running', node: 'running', task: 'running' });
    const resumed = await getTaskById(db, task.id);
    expect(resumed?.result).toMatchObject({
      subChatId: 'sub-1',
      startMode: 'execute',
      skipReview: false,
      resumedBy: 'follow_up_message',
      previousStatus: 'plan_ready',
    });
    // The agent's done now finishes the task instead of asking for approval again.
    if (!resumed) throw new Error('task missing');
    expect(resolveTaskSignalTransition(resumed, { state: 'done', summary: 'built' }).status).toBe(
      'done',
    );
  });

  it('writes nothing when the run panel already approved the plan', async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK });
    await setNodeRunStatus(db, nodeRunId, 'completed', { completedAt: new Date() });
    await setFlowRunStatus(db, flowRunId, 'running');

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(false);
    expect(await getTaskById(db, task.id)).toEqual(task);
    expect(await statuses(task.id)).toEqual({
      run: 'running',
      node: 'completed',
      task: 'plan_ready',
    });
  });

  it('leaves a flow-less plan review to its own path', async () => {
    const task = await createTask(db, { description: 'manual', source: 'manual' });
    await updateTaskStatus(db, task.id, 'running');
    const parked = await updateTaskStatus(db, task.id, 'plan_ready', { result: PLAN_PARK });
    if (!parked) throw new Error('park failed');

    expect(await resumeParkedTaskInPlace(parked, 'follow_up_message', 'sub-1')).toBe(false);
    expect((await getTaskById(db, task.id))?.status).toBe('plan_ready');
  });

  it('a wake never approves a plan', async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK });

    expect(await resumeParkedTaskInPlace(task, 'wake_burst', 'sub-1')).toBe(false);
    expect(await getTaskById(db, task.id)).toEqual(task);
    expect(await statuses(task.id)).toEqual({
      run: 'paused',
      node: 'awaiting_input',
      task: 'plan_ready',
    });
  });
});

describe('resumeParkedTaskInPlace — plan approval edge cases', () => {
  const PLAN_PARK = { subChatId: 'sub-1', startMode: 'plan', skipReview: false };

  it("the agent's done lands through the real signal write and finishes the task", async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK });
    await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1');

    const applied = await persistLinkedTaskSignal({
      taskIdForExecution: task.id,
      signal: { state: 'done', summary: 'built' },
    });

    expect(applied).toBe(true);
    expect((await getTaskById(db, task.id))?.status).toBe('done');
  });

  it('a real panel Approve that lands first makes the reply a no-op', async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK });
    await resumeFlowRun(flowRunId, 'approve', nodeRunId);
    const afterApprove = await statuses(task.id);

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(false);
    expect(await getTaskById(db, task.id)).toEqual(task);
    expect(await statuses(task.id)).toEqual(afterApprove);
  });

  it('a panel Approve that loses to the reply is declined and advances nothing', async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK });
    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(true);

    await expect(resumeFlowRun(flowRunId, 'approve', nodeRunId)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(await statuses(task.id)).toEqual({ run: 'running', node: 'running', task: 'running' });
  });

  it('two replies from different panes resume once', async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK });

    const results = await Promise.all([
      resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1'),
      resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await statuses(task.id)).toEqual({ run: 'running', node: 'running', task: 'running' });
  });

  it('rolls the task back when the run lost its admission slot', async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK, slot: false });

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(false);
    expect(await getTaskById(db, task.id)).toEqual(task);
    expect(await statuses(task.id)).toEqual({
      run: 'paused',
      node: 'awaiting_input',
      task: 'plan_ready',
    });
  });

  it('rolls the task back when it has no node to unpark', async () => {
    const seeded = await seedParkedTask('plan_ready', { result: PLAN_PARK });
    const task = { ...seeded, nodeRunId: null };

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(false);
    expect((await getTaskById(db, task.id))?.status).toBe('plan_ready');
    expect(await statuses(task.id)).toEqual({
      run: 'paused',
      node: 'awaiting_input',
      task: 'plan_ready',
    });
  });

  it('a reply after a Cancel never revives the plan', async () => {
    const task = await seedParkedTask('plan_ready', { result: PLAN_PARK });
    await cancelFlowRun(flowRunId);
    const afterCancel = await statuses(task.id);

    expect(await resumeParkedTaskInPlace(task, 'follow_up_message', 'sub-1')).toBe(false);
    expect(await statuses(task.id)).toEqual(afterCancel);
    expect(afterCancel.task).not.toBe('running');
  });
});
