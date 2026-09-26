import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  dispatcher: vi.fn(async (_flowRunId: string) => {}),
  emitRunTerminal: vi.fn(),
}));

vi.mock('../../db', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../event-emit', () => ({
  emitRunTerminal: mocks.emitRunTerminal,
}));

import { flowRunAdmissions, flowRuns, flows, flowVersions, nodeRuns, tasks } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { beginFlowResourceActivity } from './activity';
import { _resetFlowAdmissionControllerMutexForTests, FlowAdmissionController } from './controller';
import {
  _setFlowAdmissionControllerForTests,
  hasActiveFlowAdmission,
  hasLiveFlowAdmission,
  recoverFlowAdmissions,
  registerFlowAdmissionStartDispatcher,
  registerTerminalFlowResumeDispatcher,
  requestFlowAdmissionRelease,
  requestFlowStart,
  updateFlowAdmissionSettings,
} from './runtime';
import { stageContinuationResume } from './terminal-resume/continuation';

let maxConcurrentRuns = 1;
let concurrencyLimitEnabled = true;
const config = async () => ({
  version: 1 as const,
  concurrencyLimitEnabled,
  maxConcurrentRuns,
});
const startInput = (key: string) => ({
  flowVersionId: 'version-runtime',
  triggerContext: { source: 'test' },
  idempotencyKey: key,
  batchId: null,
});

function persistWait(flowRunId: string, taskStatus?: string): void {
  const nodeRunId = `${flowRunId}-wait`;
  db.insert(nodeRuns)
    .values({
      id: nodeRunId,
      flowRunId,
      nodeId: 'wait',
      blockType: taskStatus ? 'agent' : 'approval',
      status: 'awaiting_input',
    })
    .run();
  if (taskStatus) {
    db.insert(tasks)
      .values({
        id: `${flowRunId}-task`,
        description: 'Flow wait',
        source: 'flow',
        flowRunId,
        nodeRunId,
        status: taskStatus,
      })
      .run();
  }
  db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, flowRunId)).run();
}

let db: TestDb;
let controller: FlowAdmissionController;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatcher.mockResolvedValue(undefined);
  maxConcurrentRuns = 1;
  concurrencyLimitEnabled = true;
  _resetFlowAdmissionControllerMutexForTests();
  db = freshDb();
  db.insert(flows).values({ id: 'flow-runtime', name: 'Runtime recovery' }).run();
  db.insert(flowVersions)
    .values({
      id: 'version-runtime',
      flowId: 'flow-runtime',
      versionNumber: 1,
      graph: { nodes: [{ id: 'trigger', blockType: 'manual_trigger' }], edges: [] },
    })
    .run();
  mocks.getDatabase.mockReturnValue(db);
  controller = new FlowAdmissionController(db, config, async (patch) => {
    concurrencyLimitEnabled = patch.concurrencyLimitEnabled ?? concurrencyLimitEnabled;
    maxConcurrentRuns = patch.maxConcurrentRuns ?? maxConcurrentRuns;
    return config();
  });
  _setFlowAdmissionControllerForTests(controller);
  registerFlowAdmissionStartDispatcher(mocks.dispatcher);
});

afterEach(() => {
  _setFlowAdmissionControllerForTests(null);
});
describe('Flow admission runtime recovery', () => {
  it('auto-dispatches a proven-unstarted queued activation at most once', async () => {
    const queued = await controller.enqueueStart(startInput('queued-on-boot'));
    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 0 });
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(1));
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, queued.run.id)).get()).toMatchObject({
      status: 'running',
      startedAt: expect.any(Date),
    });
    expect(await controller.getLiveForRun(queued.run.id)).toMatchObject({ state: 'active' });
    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 0, ambiguous: 1 });
    expect(mocks.dispatcher).toHaveBeenCalledTimes(1);
  });
  it('freezes admission only for the QA profile, never on the flag alone', async () => {
    process.env.FRINK_DISABLE_FLOW_ADMISSION_DRAIN = '1';
    try {
      // The flag alone must do nothing: inherited into a real session it would strand live work.
      const unscoped = await controller.enqueueStart(startInput('flag-without-qa-profile'));
      await recoverFlowAdmissions();
      await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalled());
      expect(await controller.getLiveForRun(unscoped.run.id)).toMatchObject({ state: 'active' });

      mocks.dispatcher.mockClear();
      process.env.MAIN_VITE_AUTH_SERVER_PORT = '21399';
      const queued = await controller.enqueueStart(startInput('frozen-queue'));
      await recoverFlowAdmissions();

      expect(mocks.dispatcher).not.toHaveBeenCalled();
      expect(await controller.getLiveForRun(queued.run.id)).toMatchObject({ state: 'queued' });
    } finally {
      delete process.env.FRINK_DISABLE_FLOW_ADMISSION_DRAIN;
      delete process.env.MAIN_VITE_AUTH_SERVER_PORT;
    }
  });
  it('awaits overlapping start drains before returning canonical run state', async () => {
    maxConcurrentRuns = 10;
    const starts = await Promise.all(
      Array.from({ length: 10 }, (_, index) => requestFlowStart(startInput(`overlap-${index}`))),
    );
    expect(starts.every(({ run }) => run.status === 'running')).toBe(true);
    expect(mocks.dispatcher).toHaveBeenCalledTimes(10);
  });
  it('returns settings in snake case and drains immediately after a raise or Unlimited', async () => {
    const first = await requestFlowStart(startInput('settings-first'));
    const second = await requestFlowStart(startInput('settings-second'));
    expect(first.run.status).toBe('running');
    expect(second.run.status).toBe('pending');

    await expect(updateFlowAdmissionSettings({ maxConcurrentRuns: 2 })).resolves.toEqual({
      concurrency_limit_enabled: true,
      max_concurrent_runs: 2,
      occupied_runs: 2,
      queued_runs: 0,
      draining: false,
    });
    expect(mocks.dispatcher).toHaveBeenCalledTimes(2);

    const third = await requestFlowStart(startInput('settings-third'));
    expect(third.run.status).toBe('pending');
    await expect(
      updateFlowAdmissionSettings({ concurrencyLimitEnabled: false }),
    ).resolves.toMatchObject({
      concurrency_limit_enabled: false,
      max_concurrent_runs: 2,
      occupied_runs: 3,
      queued_runs: 0,
      draining: false,
    });
    expect(mocks.dispatcher).toHaveBeenCalledTimes(3);
  });
  it('reports saved settings when the follow-up drain fails', async () => {
    vi.spyOn(controller, 'claimEligible').mockRejectedValueOnce(new Error('drain failed'));

    await expect(updateFlowAdmissionSettings({ maxConcurrentRuns: 2 })).resolves.toMatchObject({
      max_concurrent_runs: 2,
    });
  });
  it('requeues a proven-unstarted claim without replaying active work', async () => {
    maxConcurrentRuns = 2;
    const first = await controller.enqueueStart(startInput('claimed-on-boot'));
    const second = await controller.enqueueStart(startInput('active-on-boot'));
    const [firstClaim, secondClaim] = (await controller.claimEligible()).admissions;
    await controller.beginDispatch(firstClaim.ticket);
    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 1 });
    expect(await controller.getLiveForRun(first.run.id)).toMatchObject({ state: 'active' });
    expect(await controller.getLiveForRun(second.run.id)).toMatchObject({
      ticket: secondClaim.ticket,
      state: 'active',
    });
    expect(mocks.dispatcher).toHaveBeenCalledOnce();
    expect(mocks.dispatcher).toHaveBeenCalledWith(second.run.id);
  });
  describe('a releasing admission left by a dead process', () => {
    /** An active run whose release began but never settled — the shape a crashed teardown leaves. */
    async function leaveReleasing(runStatus: 'paused' | 'cancelled', cleanupError?: string) {
      const first = await requestFlowStart(startInput('left-releasing'));
      await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(1));
      const queued = await requestFlowStart(startInput('queued-behind-releasing'));
      db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, first.run.id)).run();
      await requestFlowAdmissionRelease(first.run.id);
      const live = await controller.getLiveForRun(first.run.id);
      if (cleanupError && live) await controller.recordReleaseFailure(live.ticket, cleanupError);
      db.update(flowRuns).set({ status: runStatus }).where(eq(flowRuns.id, first.run.id)).run();
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({
        state: 'releasing',
        error: cleanupError ?? null,
      });
      return { first, queued };
    }

    it('hands a paused run its slot back as active, so it is resumable and cancellable again', async () => {
      const { first, queued } = await leaveReleasing('paused', 'Claude session cleanup timed out');
      await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 1 });
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({
        state: 'active',
        error: null,
      });
      expect(await hasActiveFlowAdmission(first.run.id)).toBe(true);
      // The paused run keeps its slot, so the queued start still waits.
      expect(mocks.dispatcher).toHaveBeenCalledTimes(1);
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, queued.run.id)).get()).toMatchObject({
        status: 'pending',
        startedAt: null,
      });
    });

    it('restores a paused run whose release never recorded an error (crash mid-teardown)', async () => {
      const { first } = await leaveReleasing('paused');
      await recoverFlowAdmissions();
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({ state: 'active' });
    });

    it('settles a terminal run to its outcome, keeps the recorded error, and frees the slot', async () => {
      const { first, queued } = await leaveReleasing('cancelled', 'provider iterator hung');
      await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 1 });
      expect(
        db
          .select()
          .from(flowRunAdmissions)
          .where(eq(flowRunAdmissions.flowRunId, first.run.id))
          .get(),
      ).toMatchObject({ state: 'cancelled', error: 'provider iterator hung' });
      await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(2));
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, queued.run.id)).get()).toMatchObject({
        status: 'running',
      });
    });
  });

  it('releases an active claim when the run is no longer dispatchable', async () => {
    const getLiveForRun = controller.getLiveForRun.bind(controller);
    vi.spyOn(controller, 'getLiveForRun').mockImplementationOnce((flowRunId) => {
      db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, flowRunId)).run();
      return getLiveForRun(flowRunId);
    });

    const started = await requestFlowStart(startInput('non-dispatchable'));

    await vi.waitFor(async () => {
      expect(
        db
          .select()
          .from(flowRunAdmissions)
          .where(eq(flowRunAdmissions.flowRunId, started.run.id))
          .get(),
      ).toMatchObject({ state: 'failed' });
    });
    expect(mocks.dispatcher).not.toHaveBeenCalled();

    const next = await requestFlowStart(startInput('after-non-dispatchable'));
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledWith(next.run.id));
  });
  it('stops recovery before reprocessing a non-advancing page', async () => {
    const queued = await controller.enqueueStart(startInput('stuck-cursor'));
    expect(queued.admission).not.toBeNull();
    const admission = queued.admission;
    if (!admission) throw new Error('Expected queued admission');
    const page = {
      autoDrainable: [admission],
      ambiguous: [],
      nextTicket: admission.ticket,
    };
    vi.spyOn(controller, 'recoverySnapshot')
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page);

    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 0 });
    expect(controller.recoverySnapshot).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledOnce());
  });
  it('emits a terminal failure when queued intent validation rejects a start', async () => {
    const queued = await controller.enqueueStart(startInput('invalid-on-boot'));
    db.update(flowRunAdmissions)
      .set({ intentVersion: 99 })
      .where(eq(flowRunAdmissions.ticket, queued.admission?.ticket ?? -1))
      .run();
    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 0 });
    const failedRun = db.select().from(flowRuns).where(eq(flowRuns.id, queued.run.id)).get();
    expect(failedRun?.status).toBe('failed');
    expect(mocks.emitRunTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'flow-runtime' }),
      queued.run.id,
      'failed',
      expect.objectContaining({ summary: expect.stringContaining('Unsupported') }),
    );
    expect(mocks.dispatcher).not.toHaveBeenCalled();
  });
  it('settles a recovered terminal activation before promoting queued work', async () => {
    const begun = await controller.enqueueStart(startInput('terminal-on-boot'));
    const queued = await controller.enqueueStart(startInput('next-on-boot'));
    const claim = (await controller.claimEligible()).admissions[0];
    await controller.beginDispatch(claim.ticket);
    db.update(flowRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(flowRuns.id, begun.run.id))
      .run();
    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 1 });
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(1));
    expect(
      db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, claim.ticket)).get(),
    ).toMatchObject({ state: 'released' });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, queued.run.id)).get()).toMatchObject({
      status: 'running',
      startedAt: expect.any(Date),
    });
  });
  it.each([
    ['completed', 'released'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'holds a %s run lease until final activity settles, then promotes once',
    async (runStatus, admissionOutcome) => {
      let finishFirst!: () => void;
      const firstExecution = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      mocks.dispatcher.mockImplementationOnce(async () => firstExecution);
      const first = await requestFlowStart(startInput(`lease-${runStatus}`));
      await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(1));
      expect(await hasActiveFlowAdmission(first.run.id)).toBe(true);
      expect(await hasLiveFlowAdmission(first.run.id)).toBe(true);
      const second = await requestFlowStart(startInput(`next-${runStatus}`));
      // Second request is queued behind the cap — still LIVE, just not active.
      expect(await hasLiveFlowAdmission(second.run.id)).toBe(true);
      db.update(flowRuns)
        .set({ status: runStatus, completedAt: new Date() })
        .where(eq(flowRuns.id, first.run.id))
        .run();
      await requestFlowAdmissionRelease(first.run.id);
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({ state: 'releasing' });
      expect(await hasActiveFlowAdmission(first.run.id)).toBe(false);
      // 'releasing' is still a live state — the run has not settled to failed/cancelled yet.
      expect(await hasLiveFlowAdmission(first.run.id)).toBe(true);
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get()).toMatchObject({
        status: 'pending',
        startedAt: null,
      });
      finishFirst();
      await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(2));
      expect(
        db
          .select()
          .from(flowRunAdmissions)
          .where(eq(flowRunAdmissions.flowRunId, first.run.id))
          .get(),
      ).toMatchObject({ state: admissionOutcome });
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get()).toMatchObject({
        status: 'running',
        startedAt: expect.any(Date),
      });
    },
  );
  it('retains a cleanup failure and does not promote queued work', async () => {
    const first = await requestFlowStart(startInput('cleanup-failure'));
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(1));
    const releaseCleanup = beginFlowResourceActivity(first.run.id);
    const second = await requestFlowStart(startInput('blocked-by-cleanup'));
    db.update(flowRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(flowRuns.id, first.run.id))
      .run();
    await requestFlowAdmissionRelease(first.run.id);
    releaseCleanup(new Error('provider teardown failed'));
    await vi.waitFor(async () => {
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({
        state: 'releasing',
        error: 'provider teardown failed',
      });
    });
    const blockedRun = db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get();
    expect(blockedRun?.status).toBe('pending');
    expect(mocks.dispatcher).toHaveBeenCalledTimes(1);
  });
  it('retains cleanup failure reported before a run reaches a releasable state', async () => {
    mocks.dispatcher.mockImplementationOnce(async (flowRunId) => {
      const releaseProvider = beginFlowResourceActivity(flowRunId);
      releaseProvider(new Error('running provider teardown unconfirmed'));
    });
    const first = await requestFlowStart(startInput('running-cleanup-failure'));
    await vi.waitFor(async () => {
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({
        state: 'releasing',
        error: 'running provider teardown unconfirmed',
      });
    });
    const second = await requestFlowStart(startInput('blocked-by-running-cleanup'));
    db.update(flowRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(flowRuns.id, first.run.id))
      .run();
    await requestFlowAdmissionRelease(first.run.id);

    expect(await controller.getLiveForRun(first.run.id)).toMatchObject({
      state: 'releasing',
      error: 'running provider teardown unconfirmed',
    });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    expect(mocks.dispatcher).toHaveBeenCalledOnce();
  });
  it('keeps a durable stable wait occupied after its execution owner settles and on recovery', async () => {
    let settleExecution!: () => void;
    const execution = new Promise<void>((resolve) => {
      settleExecution = resolve;
    });
    mocks.dispatcher.mockImplementationOnce(async (flowRunId) => {
      persistWait(flowRunId);
      await execution;
    });
    const first = await requestFlowStart(startInput('approval-wait'));
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledOnce());
    const second = await requestFlowStart(startInput('after-approval'));

    expect(await controller.getLiveForRun(first.run.id)).toMatchObject({ state: 'active' });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });

    settleExecution();
    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 1 });
    expect(await controller.getLiveForRun(first.run.id)).toMatchObject({ state: 'active' });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    expect(mocks.dispatcher).toHaveBeenCalledOnce();
  });
  it('keeps an agent hand-off active while its Flow task is pending', async () => {
    mocks.dispatcher.mockImplementationOnce(async (flowRunId) => persistWait(flowRunId, 'pending'));
    const first = await requestFlowStart(startInput('agent-handoff'));
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledOnce());
    const second = await requestFlowStart(startInput('blocked-by-handoff'));

    await vi.waitFor(async () => {
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({ state: 'active' });
    });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    expect(mocks.dispatcher).toHaveBeenCalledOnce();
  });
  it('retains cleanup failure when a hand-off parks after teardown', async () => {
    mocks.dispatcher.mockImplementationOnce(async (flowRunId) => {
      const releaseProvider = beginFlowResourceActivity(flowRunId);
      persistWait(flowRunId, 'running');
      releaseProvider(new Error('provider teardown unconfirmed'));
    });
    const first = await requestFlowStart(startInput('late-park-cleanup-failure'));
    await vi.waitFor(async () => {
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({
        state: 'releasing',
        error: 'provider teardown unconfirmed',
      });
    });
    const second = await requestFlowStart(startInput('blocked-after-late-park'));
    db.update(tasks)
      .set({ status: 'needs_attention' })
      .where(eq(tasks.flowRunId, first.run.id))
      .run();
    await requestFlowAdmissionRelease(first.run.id);

    expect(await controller.getLiveForRun(first.run.id)).toMatchObject({
      state: 'releasing',
      error: 'provider teardown unconfirmed',
    });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    expect(mocks.dispatcher).toHaveBeenCalledOnce();
  });
  it('retains a stable-wait permit when executor cleanup fails', async () => {
    mocks.dispatcher.mockImplementationOnce(async (flowRunId) => {
      const releaseProvider = beginFlowResourceActivity(flowRunId);
      persistWait(flowRunId, 'needs_attention');
      releaseProvider(new Error('question provider still alive'));
    });
    const first = await requestFlowStart(startInput('question-cleanup-failure'));
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledOnce());
    const second = await requestFlowStart(startInput('blocked-by-question-cleanup'));

    await vi.waitFor(async () => {
      expect(await controller.getLiveForRun(first.run.id)).toMatchObject({
        state: 'releasing',
        error: 'question provider still alive',
      });
    });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, second.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    expect(mocks.dispatcher).toHaveBeenCalledOnce();
  });
  it('a staged continuation takes the slot its own settle frees, ahead of a queued start', async () => {
    const resumeDispatcher = vi.fn(async () => {});
    registerTerminalFlowResumeDispatcher(resumeDispatcher);
    const interrupted = await requestFlowStart(startInput('interrupted-on-boot'));
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(1));
    const flowRunId = interrupted.run.id;
    // Cap is 1, so this start waits behind the interrupted run.
    const queuedStart = await requestFlowStart(startInput('queued-behind-interruption'));
    db.insert(nodeRuns)
      .values({
        id: 'interrupted-node-run',
        flowRunId,
        nodeId: 'agent',
        blockType: 'agent',
        status: 'cancelled',
      })
      .run();
    db.update(flowRuns)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(eq(flowRuns.id, flowRunId))
      .run();
    stageContinuationResume({ flowRunId, nodeRunId: 'interrupted-node-run' }, vi.fn(), {
      intervalMs: 1,
      attempts: 1,
    });

    // The interruption settles through the same release the watcher's advance ends in.
    await requestFlowAdmissionRelease(flowRunId);

    await vi.waitFor(() => expect(resumeDispatcher).toHaveBeenCalledTimes(1));
    expect(mocks.dispatcher).toHaveBeenCalledTimes(1);
    expect(await controller.getLiveForRun(flowRunId)).toMatchObject({
      state: 'active',
      priorityClass: 'resume',
    });
    expect(
      db.select().from(flowRuns).where(eq(flowRuns.id, queuedStart.run.id)).get(),
    ).toMatchObject({ status: 'pending', startedAt: null });
  });

  it('defers a staged typed-reply continuation past BOTH the declining turn settle and the old turn teardown, then fires once', async () => {
    const resumeDispatcher = vi.fn(async (_intent: unknown) => {});
    registerTerminalFlowResumeDispatcher(resumeDispatcher);
    const first = await requestFlowStart(startInput('decline-convert'));
    await vi.waitFor(() => expect(mocks.dispatcher).toHaveBeenCalledTimes(1));
    const flowRunId = first.run.id;
    // The ORIGINAL failing turn's teardown is still in flight when the typed reply lands,
    // and the declining turn holds its own token from provider registration.
    const oldTurnRelease = beginFlowResourceActivity(flowRunId);
    const declineTurnRelease = beginFlowResourceActivity(flowRunId);
    db.insert(nodeRuns)
      .values({
        id: 'resume-node-run',
        flowRunId,
        nodeId: 'agent',
        blockType: 'agent',
        status: 'failed',
      })
      .run();
    db.update(flowRuns)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(flowRuns.id, flowRunId))
      .run();
    await requestFlowAdmissionRelease(flowRunId);
    expect(await controller.getLiveForRun(flowRunId)).toMatchObject({ state: 'releasing' });

    const emitCorrective = vi.fn();
    stageContinuationResume({ flowRunId, nodeRunId: 'resume-node-run' }, emitCorrective, {
      intervalMs: 1,
      attempts: 1,
    });

    // Declining turn settles first — the old teardown still holds run activity, so the
    // enqueue (which would be rejected against the `releasing` admission) must not fire.
    declineTurnRelease();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resumeDispatcher).not.toHaveBeenCalled();
    expect(
      db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.flowRunId, flowRunId)).all(),
    ).toHaveLength(1);

    // The old turn's FINAL release retires the prior admission; only then does the staged
    // continuation enqueue — succeeding without any corrective error.
    oldTurnRelease();
    await vi.waitFor(() => expect(resumeDispatcher).toHaveBeenCalledTimes(1));
    expect(resumeDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'resume',
        node_run_id: 'resume-node-run',
        continuation: true,
      }),
    );
    expect(emitCorrective).not.toHaveBeenCalled();
  });
});
