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
vi.mock('../sentry/init', () => ({
  captureMainException: holder.capture,
  captureMainMessage: holder.capture,
}));

import { FlowAdmissionController } from '../flows/admission/controller';
import { _setFlowAdmissionControllerForTests } from '../flows/admission/runtime';
import { cancelFlowRun } from '../flows/engine';
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
  status: 'needs_attention' | 'failed',
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
