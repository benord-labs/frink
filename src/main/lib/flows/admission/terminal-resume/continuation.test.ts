import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getFlowRun: vi.fn<() => Promise<{ id: string; status: string } | null>>(async () => null),
  getLatestFlowTaskForRun: vi.fn<() => Promise<{ id: string; status: string } | null>>(
    async () => null,
  ),
}));
const captureFlowAdmissionException = vi.hoisted(() => vi.fn());

vi.mock('../../../db', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('../../../db/repos/flow-runs', () => ({ getFlowRun: dbMocks.getFlowRun }));
vi.mock('../../../db/repos/tasks', () => ({
  getLatestFlowTaskForRun: dbMocks.getLatestFlowTaskForRun,
}));
vi.mock('../activity', () => ({ captureFlowAdmissionException }));

import {
  dropStagedContinuation,
  fireStagedContinuationResume,
  hasStagedContinuation,
  type PendingContinuationResume,
  settleWithStagedContinuation,
  stageBehindHeldAdmission,
  stageContinuationResume,
} from './continuation';
import { ResumeAdmitDeclinedError, TerminalResumeAdmissionError } from './resume-store';

const PENDING = { flowRunId: 'flow-run', nodeRunId: 'node-run-1' };
const db = {} as Parameters<NonNullable<PendingContinuationResume['admit']>>[0];
const FAST_WATCH = { intervalMs: 1, attempts: 3 };

const makeOps = () => ({
  requestTerminalFlowResume: vi.fn<(input: PendingContinuationResume) => Promise<object>>(
    async () => ({}),
  ),
  hasLiveFlowAdmission: vi.fn<(flowRunId: string) => Promise<boolean>>(async () => false),
  getLiveAdmissionState: vi.fn<(flowRunId: string) => Promise<string | null>>(async () => null),
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFlowRun.mockResolvedValue(null);
  dbMocks.getLatestFlowTaskForRun.mockResolvedValue(null);
});

// The dispatch runs DETACHED from requestTerminalFlowResume, so the corrective error must
// cover both failure classes: the enqueue throw AND a background dispatch failure that
// re-settles the run terminal without a new task.
describe('staged continuation resume', () => {
  it('is a no-op for a run with nothing staged (every flow teardown reaches this)', async () => {
    const ops = makeOps();
    await fireStagedContinuationResume('unstaged-run', ops);
    expect(ops.requestTerminalFlowResume).not.toHaveBeenCalled();
  });

  it('fires a staged continuation at most once', async () => {
    const ops = makeOps();
    stageContinuationResume(PENDING, vi.fn(), FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    expect(ops.requestTerminalFlowResume).toHaveBeenCalledTimes(1);
    expect(ops.requestTerminalFlowResume).toHaveBeenCalledWith(expect.objectContaining(PENDING));
  });

  it('an admit decline from a guarded entry is logged, never surfaced as a corrective', async () => {
    const ops = makeOps();
    ops.requestTerminalFlowResume.mockRejectedValueOnce(
      new ResumeAdmitDeclinedError('declined its resume admit check'),
    );
    const emitCorrective = vi.fn();
    stageContinuationResume({ ...PENDING, admit: () => false }, emitCorrective, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    expect(emitCorrective).not.toHaveBeenCalled();
    expect(captureFlowAdmissionException).not.toHaveBeenCalled();
  });

  it('a later stage for the same run keeps the earlier admit guard (typed reply after boot carry-on)', async () => {
    const ops = makeOps();
    const admit = vi.fn(() => false);
    stageContinuationResume({ ...PENDING, admit }, vi.fn(), FAST_WATCH);
    stageContinuationResume(PENDING, vi.fn(), FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    expect(ops.requestTerminalFlowResume.mock.calls[0][0].admit?.(db)).toBe(false);
    expect(admit).toHaveBeenCalledWith(db);
  });

  // A Continue clicked after boot carry-on brings its own guard; neither may drop the other.
  it('a later guarded stage keeps the earlier guard beside its own, and carries its kind', async () => {
    const ops = makeOps();
    const earlier = vi.fn(() => false);
    const own = vi.fn(() => true);
    stageContinuationResume({ ...PENDING, admit: earlier }, vi.fn(), FAST_WATCH);
    stageContinuationResume({ ...PENDING, kind: 'continue', admit: own }, vi.fn(), FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    const input = ops.requestTerminalFlowResume.mock.calls[0][0];
    expect(input.kind).toBe('continue');
    expect(input.admit?.(db)).toBe(false);
    expect(own).toHaveBeenCalledWith(db);
    expect(earlier).toHaveBeenCalledWith(db);
  });

  // The held admission settles between the probe and the stage: no settle is left to fire the
  // entry, so staging fires it itself.
  it('fires a held-slot stage itself when the slot settled during staging', async () => {
    const ops = makeOps();
    ops.getLiveAdmissionState.mockResolvedValueOnce('active').mockResolvedValue(null);
    await expect(stageBehindHeldAdmission({ ...PENDING, kind: 'continue' }, ops)).resolves.toBe(
      true,
    );
    expect(hasStagedContinuation(PENDING.flowRunId)).toBe(false);
    expect(ops.requestTerminalFlowResume).toHaveBeenCalledWith(
      expect.objectContaining({ ...PENDING, kind: 'continue' }),
    );
  });

  // Still held or mid-release: the settle (or its reconcile hook) fires the entry, not the click.
  it.each(['active', 'releasing'])(
    'leaves a held-slot stage for the settle while the slot is %s',
    async (state) => {
      const ops = makeOps();
      ops.getLiveAdmissionState.mockResolvedValueOnce('active').mockResolvedValue(state);
      await expect(stageBehindHeldAdmission(PENDING, ops)).resolves.toBe(true);
      expect(hasStagedContinuation(PENDING.flowRunId)).toBe(true);
      expect(ops.requestTerminalFlowResume).not.toHaveBeenCalled();
      dropStagedContinuation(PENDING.flowRunId);
    },
  );

  // A slot mid-release still refuses a second admission, so the click waits for its settle too.
  it('stages behind a slot that is releasing rather than enqueueing into it', async () => {
    const ops = makeOps();
    ops.getLiveAdmissionState.mockResolvedValue('releasing');
    await expect(stageBehindHeldAdmission(PENDING, ops)).resolves.toBe(true);
    expect(hasStagedContinuation(PENDING.flowRunId)).toBe(true);
    expect(ops.requestTerminalFlowResume).not.toHaveBeenCalled();
    dropStagedContinuation(PENDING.flowRunId);
  });

  // A release that kept a cleanup error never settles on its own, so nothing would fire the stage.
  it('refuses a click behind a release that kept a cleanup error, staging nothing', async () => {
    const ops = makeOps();
    ops.getLiveAdmissionState.mockResolvedValue('retained');
    await expect(stageBehindHeldAdmission(PENDING, ops)).rejects.toThrow(/failed cleanup/);
    expect(hasStagedContinuation(PENDING.flowRunId)).toBe(false);
  });

  it('reports a staged continuation until it fires or a Cancel drops it', async () => {
    const ops = makeOps();
    expect(hasStagedContinuation(PENDING.flowRunId)).toBe(false);
    stageContinuationResume(PENDING, vi.fn(), FAST_WATCH);
    expect(hasStagedContinuation(PENDING.flowRunId)).toBe(true);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    expect(hasStagedContinuation(PENDING.flowRunId)).toBe(false);
    stageContinuationResume(PENDING, vi.fn(), FAST_WATCH);
    dropStagedContinuation(PENDING.flowRunId);
    expect(hasStagedContinuation(PENDING.flowRunId)).toBe(false);
  });

  it('declines the enqueue of an entry a Cancel dropped while the fire held it', async () => {
    const ops = makeOps();
    stageContinuationResume(PENDING, vi.fn(), FAST_WATCH);
    ops.getLiveAdmissionState.mockImplementationOnce(async () => {
      dropStagedContinuation(PENDING.flowRunId);
      return null;
    });
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    expect(ops.requestTerminalFlowResume.mock.calls[0][0].admit?.(db)).toBe(false);
  });

  describe('settleWithStagedContinuation', () => {
    type SettleResult = { settled: boolean; declined: TerminalResumeAdmissionError | null };
    const stubController = (settleWithContinuation: () => Promise<SettleResult>) => ({
      settle: vi.fn(async () => null),
      settleWithContinuation,
    });

    it('keeps the entry staged when the transactional settle throws, so a later settle still resumes', async () => {
      const ops = makeOps();
      stageContinuationResume(PENDING, vi.fn(), FAST_WATCH);
      const failing = stubController(async () => {
        throw new Error('sqlite busy');
      });
      await expect(
        settleWithStagedContinuation(failing, 1, 'cancelled', PENDING.flowRunId, ops),
      ).rejects.toThrow('sqlite busy');
      const working = stubController(async () => ({ settled: true, declined: null }));
      expect(
        await settleWithStagedContinuation(working, 1, 'cancelled', PENDING.flowRunId, ops),
      ).toBe(true);
      expect(working.settle).not.toHaveBeenCalled();
    });

    it('leaves a newer entry staged when it lands during the settle await', async () => {
      const ops = makeOps();
      stageContinuationResume(PENDING, vi.fn(), FAST_WATCH);
      const newer = { ...PENDING, nodeRunId: 'node-run-2' };
      const restaging = stubController(async () => {
        stageContinuationResume(newer, vi.fn(), FAST_WATCH);
        return { settled: true, declined: null };
      });
      await settleWithStagedContinuation(restaging, 1, 'cancelled', PENDING.flowRunId, ops);
      await fireStagedContinuationResume(PENDING.flowRunId, ops);
      expect(ops.requestTerminalFlowResume).toHaveBeenCalledWith(
        expect.objectContaining({ nodeRunId: 'node-run-2' }),
      );
    });

    it('surfaces a real enqueue rejection as a corrective, but only logs an admit decline', async () => {
      const ops = makeOps();
      const emitCorrective = vi.fn();
      stageContinuationResume(PENDING, emitCorrective, FAST_WATCH);
      const rejected = stubController(async () => ({
        settled: true,
        declined: new TerminalResumeAdmissionError('requires batch resume admission'),
      }));
      await settleWithStagedContinuation(rejected, 1, 'failed', PENDING.flowRunId, ops);
      expect(emitCorrective).toHaveBeenCalledTimes(1);

      stageContinuationResume(PENDING, emitCorrective, FAST_WATCH);
      const declined = stubController(async () => ({
        settled: true,
        declined: new ResumeAdmitDeclinedError('abandoned meanwhile'),
      }));
      await settleWithStagedContinuation(declined, 1, 'failed', PENDING.flowRunId, ops);
      expect(emitCorrective).toHaveBeenCalledTimes(1);
    });
  });

  // `retained` (a release that kept a cleanup error) must stay staged too, not read as a newer
  // admission that supersedes the entry.
  it.each(['releasing', 'retained'])(
    'a prior admission still %s at fire time keeps the continuation staged — the settle-bailing reconcile is not the one that freed the run; a later fire delivers it',
    async (state) => {
      const ops = makeOps();
      ops.getLiveAdmissionState.mockResolvedValueOnce(state);
      const emit = vi.fn();
      stageContinuationResume(PENDING, emit, FAST_WATCH);
      await fireStagedContinuationResume(PENDING.flowRunId, ops);
      expect(ops.requestTerminalFlowResume).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      // The next final release re-enters with the run actually free — the entry survived.
      await fireStagedContinuationResume(PENDING.flowRunId, ops);
      expect(ops.requestTerminalFlowResume).toHaveBeenCalledWith(expect.objectContaining(PENDING));
    },
  );

  it("a queued/claimed admission for the run supersedes the staged continuation silently — that admission's own claim delivers the reply", async () => {
    const ops = makeOps();
    ops.getLiveAdmissionState.mockResolvedValue('queued');
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    expect(ops.requestTerminalFlowResume).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    // Superseded means consumed: a later fire finds nothing staged.
    ops.getLiveAdmissionState.mockResolvedValue(null);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    expect(ops.requestTerminalFlowResume).not.toHaveBeenCalled();
  });

  it('a cleanup failure abandons the staged continuation explicitly — corrective + capture, no enqueue (the retained admission blocks re-admission until manual recovery)', async () => {
    const ops = makeOps();
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops, new Error('teardown failed'));
    expect(ops.requestTerminalFlowResume).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('Continue or Retry'));
    expect(captureFlowAdmissionException).toHaveBeenCalledWith(
      expect.any(Error),
      'continuation-cleanup-failed',
    );
  });

  it('emits the corrective error (and a Sentry capture) when the enqueue itself throws', async () => {
    const ops = makeOps();
    ops.requestTerminalFlowResume.mockRejectedValueOnce(new Error('different live admission'));
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('Continue or Retry'));
    expect(captureFlowAdmissionException).toHaveBeenCalledWith(
      expect.any(Error),
      'continuation-enqueue',
    );
  });

  it('emits the corrective error when the background dispatch fails (run re-settles terminal, no new task)', async () => {
    dbMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'failed' });
    dbMocks.getLatestFlowTaskForRun.mockResolvedValue({ id: 'task-old', status: 'cancelled' });
    const ops = makeOps();
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(expect.stringContaining('Continue or Retry')),
    );
  });

  it('stays silent once the dispatch mints a NEW flow task (its turn owns the surfaces from there)', async () => {
    dbMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'running' });
    dbMocks.getLatestFlowTaskForRun
      .mockResolvedValueOnce({ id: 'task-old', status: 'cancelled' })
      .mockResolvedValue({ id: 'task-new', status: 'pending' });
    const ops = makeOps();
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(emit).not.toHaveBeenCalled();
  });

  it('stays silent while the run keeps running without settling (bounded watch expires)', async () => {
    dbMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'running' });
    dbMocks.getLatestFlowTaskForRun.mockResolvedValue({ id: 'task-old', status: 'cancelled' });
    const ops = makeOps();
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(emit).not.toHaveBeenCalled();
  });

  it('a capacity-QUEUED admission is not misread as a dispatch failure — the run stays terminal with no new task, but a live admission exists', async () => {
    // enqueueTerminalFlowResume does not throw when the concurrency cap is full; it
    // returns `queued`, so the run's own status/task signals alone are indistinguishable
    // from a lost dispatch. hasLiveFlowAdmission is the disambiguator.
    dbMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'failed' });
    dbMocks.getLatestFlowTaskForRun.mockResolvedValue({ id: 'task-old', status: 'cancelled' });
    const ops = makeOps();
    ops.hasLiveFlowAdmission.mockResolvedValue(true);
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(emit).not.toHaveBeenCalled();
  });

  it('a dispatch lost AFTER a long capacity-queue wait still draws the corrective — live ticks pause the miss budget instead of eating it', async () => {
    dbMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'failed' });
    dbMocks.getLatestFlowTaskForRun.mockResolvedValue({ id: 'task-old', status: 'cancelled' });
    const ops = makeOps();
    // Queued longer than the whole miss budget (attempts=3), THEN dropped.
    ops.hasLiveFlowAdmission
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(expect.stringContaining('Continue or Retry')),
    );
  });

  it('an admission still queued when the hard ceiling expires becomes telemetry, never a lying corrective', async () => {
    dbMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'failed' });
    dbMocks.getLatestFlowTaskForRun.mockResolvedValue({ id: 'task-old', status: 'cancelled' });
    const ops = makeOps();
    ops.hasLiveFlowAdmission.mockResolvedValue(true);
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    await vi.waitFor(() =>
      expect(captureFlowAdmissionException).toHaveBeenCalledWith(
        expect.any(Error),
        'continuation-watch-expired',
      ),
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('once the admission is no longer live (dropped from queued/claimed) AND the run is terminal with no new task, the corrective fires', async () => {
    dbMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'cancelled' });
    dbMocks.getLatestFlowTaskForRun.mockResolvedValue({ id: 'task-old', status: 'cancelled' });
    const ops = makeOps();
    ops.hasLiveFlowAdmission.mockResolvedValue(false);
    const emit = vi.fn();
    stageContinuationResume(PENDING, emit, FAST_WATCH);
    await fireStagedContinuationResume(PENDING.flowRunId, ops);
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(expect.stringContaining('Continue or Retry')),
    );
  });
});
