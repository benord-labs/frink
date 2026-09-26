import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import type { FlowExecutionEvent } from '../../../../../shared/types/flow';
import { getFlowRun, setFlowRunStatus } from '../../../db/repos/flow-runs';
import { createTask, getTaskById, updateTaskStatus } from '../../../db/repos/tasks';
import { flowRuns } from '../../../db/schema';
import { seedFlowRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb } from '../../../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  cancelUndispatched: vi.fn(),
  hasLive: vi.fn(async () => false),
  hasPromoted: vi.fn(),
}));

vi.mock('../../../db', async (original) => ({
  ...(await original<typeof import('../../../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../runtime', () => ({
  cancelUndispatchedFlowAdmission: holder.cancelUndispatched,
  hasLiveFlowAdmission: holder.hasLive,
  hasPromotedFlowAdmission: holder.hasPromoted,
  registerFlowAdmissionStartDispatcher: vi.fn(),
  registerTerminalFlowResumeDispatcher: vi.fn(),
  requestFlowStart: vi.fn(),
  requestTerminalFlowResume: vi.fn(),
}));

import { cancelFlowRun } from '../../engine';
import { subscribeFlowEvents } from '../../events';

const GRAPH: FlowGraph = {
  nodes: [
    {
      id: 'agent',
      blockType: 'agent',
      config: { instructions: 'work' },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
};

afterEach(() => {
  holder.cancelUndispatched.mockReset();
  holder.hasLive.mockReset();
  holder.hasLive.mockResolvedValue(false);
  holder.hasPromoted.mockReset();
});

describe('terminal Flow retry cancellation', () => {
  it('cancels a queued resume admission without sweeping the terminal run', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'existing terminal task',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, task.id, 'running');
    await setFlowRunStatus(db, flowRunId, 'failed');
    holder.cancelUndispatched.mockResolvedValueOnce(true);
    holder.hasPromoted.mockResolvedValueOnce(false);

    const result = await cancelFlowRun(flowRunId);

    // An ordinary cancel carries no dequeue guard: every undispatched state is fair game.
    expect(holder.cancelUndispatched).toHaveBeenCalledWith(flowRunId, undefined);
    expect(result?.status).toBe('failed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
    expect((await getTaskById(db, task.id))?.status).toBe('running');
  });

  it('cancels a retry that wins promotion after the initial terminal read', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'promoted retry task',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, task.id, 'running');
    await setFlowRunStatus(db, flowRunId, 'failed');
    holder.cancelUndispatched.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'running');
      return false;
    });
    holder.hasPromoted.mockResolvedValueOnce(true);

    const result = await cancelFlowRun(flowRunId);

    expect(result?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
  });

  it('preserves a node-first in-place revival when no admission was promoted', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'in-place revival',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, task.id, 'running');
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    holder.cancelUndispatched.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'running');
      return false;
    });
    holder.hasPromoted.mockResolvedValueOnce(false);

    const result = await cancelFlowRun(flowRunId);

    expect(result?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
    expect((await getTaskById(db, task.id))?.status).toBe('running');
  });
});

describe('Work Queue dequeue', () => {
  const QUEUED_ONLY = { ticket: 7 };

  it('stays silent for a resume whose run was already terminal', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    // Dequeuing a resume cancels the admission and leaves the finished run alone.
    holder.cancelUndispatched.mockResolvedValueOnce(true);
    const seen: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((event) => seen.push(event));

    const result = await cancelFlowRun(flowRunId, { queuedOnly: QUEUED_ONLY });
    unsubscribe();

    // Replaying the run's terminal event would settle its batch stage a second time.
    expect(seen).toEqual([]);
    expect(result?.status).toBe('cancelled');
    expect(holder.hasPromoted).not.toHaveBeenCalled();
  });

  it('withholds the terminal event when a retry has already re-admitted the run', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));
    holder.cancelUndispatched.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled');
      return true;
    });
    // A replacement admission won the run between the cancellation and this emit.
    holder.hasLive.mockResolvedValueOnce(true);
    const seen: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((event) => seen.push(event));

    await cancelFlowRun(flowRunId, { queuedOnly: QUEUED_ONLY });
    unsubscribe();

    // Emitting would settle the batch stage while the replacement is still waiting to run.
    expect(seen).toEqual([]);
  });

  it('emits the terminal event a removed batch member needs to settle its stage', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));
    holder.cancelUndispatched.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled');
      return true;
    });
    holder.hasPromoted.mockResolvedValueOnce(false);
    const seen: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((event) => seen.push(event));

    const result = await cancelFlowRun(flowRunId, { queuedOnly: QUEUED_ONLY });
    unsubscribe();

    // The ticket travels into the transaction: cancelling by run alone could hit a replacement.
    expect(holder.cancelUndispatched).toHaveBeenCalledWith(flowRunId, {
      states: ['queued'],
      ...QUEUED_ONLY,
    });
    expect(result?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    // batchId on the event is what reaches onBatchRunTerminal; without it the owning stage would
    // stay `running` with no active members until the next app restart.
    expect(seen).toContainEqual(
      expect.objectContaining({ eventType: 'run_cancelled', flowRunId, batchId: 'batch-1' }),
    );
  });
});
