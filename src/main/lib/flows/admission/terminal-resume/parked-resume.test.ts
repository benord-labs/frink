import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as database from '../../../db';
import {
  flowRunAdmissions,
  flowRuns,
  flows,
  flowVersions,
  nodeRuns,
  tasks,
} from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import * as carryOn from '../../rerun/carry-on';
import * as resume from '../../resume';
import * as watcher from '../../task-completion-watcher';
import { _resetFlowAdmissionControllerMutexForTests, FlowAdmissionController } from '../controller';
import {
  _setFlowAdmissionControllerForTests,
  registerFlowAdmissionStartDispatcher,
  requestFlowAdmissionRelease,
  requestFlowStart,
} from '../runtime';
import { hasStagedContinuation } from './continuation';
import './parked-dispatch';
import { requestParkedFlowResume } from './parked-resume';

// The step verbs a claim replays are observed, never run: each has its own suite.
const getDatabase = vi.spyOn(database, 'getDatabase');
const carryOnFlowTask = vi.spyOn(carryOn, 'carryOnFlowTask');
const resumeFlowRun = vi.spyOn(resume, 'resumeFlowRun');
const advanceTerminalTask = vi.spyOn(watcher, 'advanceTerminalTask');
const startDispatcher = vi.fn(async (_flowRunId: string) => {});

let db: TestDb;
let controller: FlowAdmissionController;

/** A paused run whose agent step waits on a parked task, holding no admission. */
function seedReleasedPark(flowRunId: string, taskStatus = 'needs_attention'): string {
  const nodeRunId = `${flowRunId}-step`;
  db.insert(flowRuns)
    .values({ id: flowRunId, flowVersionId: 'version-parked', status: 'paused' })
    .run();
  db.insert(nodeRuns)
    .values({ id: nodeRunId, flowRunId, nodeId: 'step', blockType: 'agent', status: 'blocked' })
    .run();
  db.insert(tasks)
    .values({
      id: `${flowRunId}-task`,
      description: 'Flow step',
      source: 'flow',
      flowRunId,
      nodeRunId,
      sourceId: nodeRunId,
      status: taskStatus,
    })
    .run();
  return nodeRunId;
}

function taskRow(taskId: string) {
  const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!row) throw new Error(`No task ${taskId}`);
  return row;
}

const runStatus = (flowRunId: string) =>
  db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)).get()?.status;
const liveAdmission = (flowRunId: string) => controller.getLiveForRun(flowRunId);

beforeEach(() => {
  vi.clearAllMocks();
  carryOnFlowTask.mockImplementation(async (_db, taskId) => ({ ok: true, task: taskRow(taskId) }));
  resumeFlowRun.mockResolvedValue('resumed');
  advanceTerminalTask.mockResolvedValue();
  _resetFlowAdmissionControllerMutexForTests();
  db = freshDb();
  db.insert(flows).values({ id: 'flow-parked', name: 'Parked resume' }).run();
  db.insert(flowVersions)
    .values({
      id: 'version-parked',
      flowId: 'flow-parked',
      versionNumber: 1,
      graph: { nodes: [{ id: 'step', blockType: 'agent' }], edges: [] },
    })
    .run();
  getDatabase.mockReturnValue(db);
  controller = new FlowAdmissionController(db, async () => ({
    version: 1,
    queuePaused: false,
    concurrencyLimitEnabled: true,
    maxConcurrentRuns: 1,
  }));
  _setFlowAdmissionControllerForTests(controller);
  registerFlowAdmissionStartDispatcher(startDispatcher);
});

afterEach(() => {
  _setFlowAdmissionControllerForTests(null);
});

describe('requestParkedFlowResume', () => {
  it('takes a free slot back and continues the parked task in place, the run still paused', async () => {
    const nodeRunId = seedReleasedPark('run-free');
    carryOnFlowTask.mockImplementationOnce(async () => {
      expect(runStatus('run-free')).toBe('paused');
      return { ok: true, task: taskRow('run-free-task') };
    });

    await expect(requestParkedFlowResume({ flowRunId: 'run-free', nodeRunId })).resolves.toEqual({
      state: 'active',
      created: true,
    });
    await vi.waitFor(() => expect(carryOnFlowTask).toHaveBeenCalledWith(db, 'run-free-task'));
    expect(await liveAdmission('run-free')).toMatchObject({
      state: 'active',
      priorityClass: 'resume',
    });
  });

  it('replays a Runs-panel action once the slot is back', async () => {
    const nodeRunId = seedReleasedPark('run-skip');
    await requestParkedFlowResume({ flowRunId: 'run-skip', nodeRunId, action: 'skip' });
    await vi.waitFor(() =>
      expect(resumeFlowRun).toHaveBeenCalledWith(
        'run-skip',
        'skip',
        nodeRunId,
        undefined,
        undefined,
      ),
    );
    expect(carryOnFlowTask).not.toHaveBeenCalled();
  });

  it('advances a task that settled while the run held no slot', async () => {
    const nodeRunId = seedReleasedPark('run-done', 'completed');
    await requestParkedFlowResume({ flowRunId: 'run-done', nodeRunId });
    await vi.waitFor(() => expect(advanceTerminalTask).toHaveBeenCalledOnce());
    expect(runStatus('run-done')).toBe('running');
  });

  it('queues behind the cap ahead of earlier starts, and merges a repeat click', async () => {
    const occupant = await requestFlowStart({
      flowVersionId: 'version-parked',
      triggerContext: null,
      idempotencyKey: 'occupant',
      batchId: null,
    });
    const waiting = await requestFlowStart({
      flowVersionId: 'version-parked',
      triggerContext: null,
      idempotencyKey: 'waiting-start',
      batchId: null,
    });
    const nodeRunId = seedReleasedPark('run-queued');

    await expect(requestParkedFlowResume({ flowRunId: 'run-queued', nodeRunId })).resolves.toEqual({
      state: 'queued',
      created: true,
    });
    await expect(requestParkedFlowResume({ flowRunId: 'run-queued', nodeRunId })).resolves.toEqual({
      state: 'queued',
      created: false,
    });

    db.update(flowRuns).set({ status: 'completed' }).where(eq(flowRuns.id, occupant.run.id)).run();
    await requestFlowAdmissionRelease(occupant.run.id);
    await vi.waitFor(() => expect(carryOnFlowTask).toHaveBeenCalledOnce());
    expect(runStatus(waiting.run.id)).toBe('pending');
    const occupied = db
      .select()
      .from(flowRunAdmissions)
      .all()
      .filter((row) => ['claimed', 'active', 'releasing'].includes(row.state));
    expect(occupied).toHaveLength(1);
  });

  // A concurrent click already took the slot back: staging behind it would replay this click on
  // the run's NEXT park, continuing the agent with nobody asking.
  it('refuses a resume once the run holds its slot again, staging nothing for a later park', async () => {
    const nodeRunId = seedReleasedPark('run-active');
    db.insert(flowRunAdmissions)
      .values({
        flowRunId: 'run-active',
        state: 'active',
        priorityClass: 'resume',
        intentVersion: 1,
        intentJson: {
          version: 1,
          action: 'resume',
          flow_run_id: 'run-active',
          node_run_id: nodeRunId,
        },
        startedAt: new Date(),
      })
      .run();

    await expect(
      requestParkedFlowResume({ flowRunId: 'run-active', nodeRunId, action: 'skip' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'This run is already resuming.',
    });
    expect(hasStagedContinuation('run-active')).toBe(false);
  });

  it('declines once a Cancel reached the run first', async () => {
    const nodeRunId = seedReleasedPark('run-cancelled');
    db.update(flowRuns).set({ status: 'cancelled' }).where(eq(flowRuns.id, 'run-cancelled')).run();
    await expect(
      requestParkedFlowResume({ flowRunId: 'run-cancelled', nodeRunId }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Flow run changed while it was being resumed.',
    });
    expect(await liveAdmission('run-cancelled')).toBeNull();
  });

  it('refuses a Continue whose step no longer continues', async () => {
    const nodeRunId = seedReleasedPark('run-retry-kind');
    await expect(
      requestParkedFlowResume({ flowRunId: 'run-retry-kind', nodeRunId, kind: 'continue' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(carryOnFlowTask).not.toHaveBeenCalled();
  });

  // A failed resume that changed nothing must not keep the slot it took: nothing would release it.
  it('leaves the run paused when the step does not continue, and gives the slot to the next run', async () => {
    const nodeRunId = seedReleasedPark('run-refused');
    carryOnFlowTask.mockResolvedValueOnce({ ok: false, reason: 'no-session' });
    // The click reports ok or the step-changed refusal, depending on which settles first.
    const click = requestParkedFlowResume({ flowRunId: 'run-refused', nodeRunId }).then(
      () => 'ok',
      (error: { code?: string }) => error.code,
    );
    const next = await requestFlowStart({
      flowVersionId: 'version-parked',
      triggerContext: null,
      idempotencyKey: 'after-refused-resume',
      batchId: null,
    });

    await vi.waitFor(() =>
      expect(startDispatcher).toHaveBeenCalledWith(next.run.id, expect.any(Number)),
    );
    expect(runStatus('run-refused')).toBe('paused');
    expect(db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get()?.status).toBe(
      'blocked',
    );
    expect(await liveAdmission('run-refused')).toBeNull();
    expect(['ok', 'PRECONDITION_FAILED']).toContain(await click);
  });

  it('keeps the slot when the failed resume had already started the step', async () => {
    const nodeRunId = seedReleasedPark('run-started');
    carryOnFlowTask.mockImplementationOnce(async () => {
      db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, 'run-started-task')).run();
      throw new Error('session dropped after the task started');
    });
    await requestParkedFlowResume({ flowRunId: 'run-started', nodeRunId });

    await vi.waitFor(() => expect(carryOnFlowTask).toHaveBeenCalledOnce());
    await vi.waitFor(async () =>
      expect(await liveAdmission('run-started')).toMatchObject({ state: 'active' }),
    );
  });
});
