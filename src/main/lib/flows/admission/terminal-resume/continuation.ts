import log from 'electron-log';
import { getDatabase } from '../../../db';
import { getFlowRun } from '../../../db/repos/flow-runs';
import { getLatestFlowTaskForRun } from '../../../db/repos/tasks';
import { captureFlowAdmissionException } from '../activity';
import type { FlowAdmissionController } from '../controller';
import { ResumeAdmitDeclinedError } from './resume-store';

type Db = ReturnType<typeof getDatabase>;
export type PendingContinuationResume = {
  flowRunId: string;
  nodeRunId: string;
  /** Checked inside the enqueue transaction, so a Cancel that lands first wins by construction. */
  admit?: (db: Db) => boolean;
};

type ContinuationWatch = { intervalMs?: number; attempts?: number };

/** Injected by runtime's lifecycle hook — the only caller — to keep this module cycle-free. */
type ContinuationAdmissionOps = {
  requestTerminalFlowResume: (
    input: PendingContinuationResume & { continuation: true },
  ) => Promise<object>;
  hasLiveFlowAdmission: (flowRunId: string) => Promise<boolean>;
  /** State of the run's live admission row, or null when none — the fire pre-flight. */
  getLiveAdmissionState: (flowRunId: string) => Promise<string | null>;
};

type StagedContinuation = {
  pending: PendingContinuationResume;
  emitCorrective: (message: string) => void;
  watch: ContinuationWatch;
  /** The run's drop generation when staged; a later Cancel's drop makes the enqueue admit decline. */
  generation: number;
};

// Both surfacing lanes render ERROR_TOAST_CONFIG's copy over this once category:'FLOW_RUN_ENDED'
// is set — kept in sync with that entry so the stored signal is never a contradicting fallback.
const CONTINUATION_CORRECTIVE_MESSAGE =
  'Use Re-run step (or Resume) above the composer to continue this flow.';

const staged = new Map<string, StagedContinuation>();
const dropGenerations = new Map<string, number>();

/**
 * Stage a typed-reply continuation re-admission for this run. The run's FINAL activity
 * release is what retires the prior admission (its reconcile), so that release — not the
 * staging turn — fires the enqueue (runtime's lifecycle hook): enqueueing any earlier
 * races the prior admission while it is still active/releasing.
 */
export function stageContinuationResume(
  pending: PendingContinuationResume,
  emitCorrective: (message: string) => void,
  watch: ContinuationWatch = {},
): void {
  // A later stage for the same run (a typed reply after boot carry-on) must keep the abandon guard.
  const admit = pending.admit ?? staged.get(pending.flowRunId)?.pending.admit;
  const generation = dropGenerations.get(pending.flowRunId) ?? 0;
  staged.set(pending.flowRunId, {
    pending: { ...pending, admit },
    emitCorrective,
    watch,
    generation,
  });
}

/** A Cancel drops the run's staged continuation in its commit tick, including one a fire or settle
 * already holds: its admit, re-read in the enqueue transaction, then declines. */
export function dropStagedContinuation(flowRunId: string): void {
  staged.delete(flowRunId);
  dropGenerations.set(flowRunId, (dropGenerations.get(flowRunId) ?? 0) + 1);
}

function droppedSinceStaged({ pending, generation }: StagedContinuation): boolean {
  return (dropGenerations.get(pending.flowRunId) ?? 0) !== generation;
}

function continuationInput(entry: StagedContinuation) {
  const { pending } = entry;
  const admit = (db: Db) => !droppedSinceStaged(entry) && (pending.admit?.(db) ?? true);
  return { ...pending, admit, continuation: true as const };
}

/**
 * Settle the prior admission and enqueue the run's staged continuation in ONE transaction, so the
 * freed slot cannot go to a queued start first. False when nothing settled (the entry stays staged).
 */
export async function settleWithStagedContinuation(
  controller: Pick<FlowAdmissionController, 'settle' | 'settleWithContinuation'>,
  ticket: number,
  outcome: Parameters<FlowAdmissionController['settle']>[1],
  flowRunId: string,
  ops: ContinuationAdmissionOps,
): Promise<boolean> {
  const entry = staged.get(flowRunId);
  if (!entry) return (await controller.settle(ticket, outcome)) !== null;
  // The entry leaves the map only once the settle committed: a thrown transaction keeps it staged.
  const result = await controller.settleWithContinuation(ticket, outcome, continuationInput(entry));
  if (!result.settled) return false;
  // Only this entry is consumed: a newer stage that landed during the await stays for the next fire.
  if (staged.get(flowRunId) === entry) staged.delete(flowRunId);
  if (result.declined instanceof ResumeAdmitDeclinedError) {
    log.info('[Flow Admission] staged continuation declined', {
      flowRunId,
      error: result.declined.message,
    });
  } else if (result.declined) {
    reportContinuationEnqueueFailure(entry, result.declined);
  } else {
    void watchContinuationDispatch(entry, ops).catch((error) =>
      log.warn('[Flow Admission] continuation dispatch watch failed:', error),
    );
  }
  return true;
}

function reportContinuationEnqueueFailure(entry: StagedContinuation, error: Error): void {
  if (droppedSinceStaged(entry)) {
    log.info('[Flow Admission] continuation ended by a Cancel', { error: error.message });
    return;
  }
  log.warn('[Flow Admission] typed-reply continuation re-admission failed:', error);
  captureFlowAdmissionException(error, 'continuation-enqueue');
  entry.emitCorrective(CONTINUATION_CORRECTIVE_MESSAGE);
}

/**
 * Fire the continuation staged for this run, if any (at most once; never throws). The
 * dispatch runs DETACHED from requestTerminalFlowResume (dispatchClaim backgrounds the
 * resume work), so a dispatch failure re-settles the run terminal without rejecting the
 * request — the bounded watch emits the corrective for that class. A successful dispatch
 * mints a new flow task and its turn's start chunk clears the optimistic toast.
 */
export async function fireStagedContinuationResume(
  flowRunId: string,
  ops: ContinuationAdmissionOps,
  cleanupError?: unknown,
): Promise<void> {
  const entry = staged.get(flowRunId);
  if (!entry) return;
  if (cleanupError !== undefined) {
    // A cleanup failure RETAINS the prior admission (capacity-lifecycle ruling: only a
    // settled cleanup releases the slot), so re-admission is blocked until manual
    // recovery — abandon explicitly instead of bouncing off the enqueue's live-admission
    // rejection, so the optimistic toast is corrected and the loss is visible.
    staged.delete(flowRunId);
    captureFlowAdmissionException(
      new Error(
        `Continuation for flow run ${flowRunId} abandoned: cleanup failure retained the prior admission`,
      ),
      'continuation-cleanup-failed',
    );
    entry.emitCorrective(CONTINUATION_CORRECTIVE_MESSAGE);
    return;
  }
  const liveState = await ops.getLiveAdmissionState(flowRunId);
  if (liveState === 'releasing') {
    // The reconcile that invoked us did NOT settle the prior admission — a concurrent
    // activity registration landed inside its async window, so its settle bailed. Stay
    // staged: that activity's own final release re-enters this hook once the run is
    // actually free, and enqueueing now would only bounce off the releasing row.
    return;
  }
  staged.delete(flowRunId);
  if (liveState !== null) {
    // Another admission (e.g. a Retry pressed alongside the typed reply) already owns
    // the run's continuation. The reply is not lost — that admission's claim reads the
    // same trailing transcript — so the staged duplicate is superseded, not dropped.
    return;
  }
  try {
    await ops.requestTerminalFlowResume(continuationInput(entry));
  } catch (error) {
    if (error instanceof ResumeAdmitDeclinedError) {
      log.info('[Flow Admission] staged continuation declined', {
        flowRunId,
        error: error.message,
      });
      return;
    }
    reportContinuationEnqueueFailure(
      entry,
      error instanceof Error ? error : new Error(String(error)),
    );
    return;
  }
  void watchContinuationDispatch(entry, ops).catch((error) =>
    log.warn('[Flow Admission] continuation dispatch watch failed:', error),
  );
}

async function watchContinuationDispatch(
  entry: StagedContinuation,
  ops: ContinuationAdmissionOps,
): Promise<void> {
  const { flowRunId } = entry.pending;
  const { intervalMs = 2_000, attempts = 30 } = entry.watch;
  const db = getDatabase();
  const before = await getLatestFlowTaskForRun(db, flowRunId);
  // `attempts` bounds only NON-live observations: a continuation legitimately queued
  // behind the concurrency cap (enqueueTerminalFlowResume returns `queued`, it does not
  // throw) can outlast any fixed budget while the FLOW_RUN_RESUMING toast stays true —
  // so live ticks pause the miss budget instead of eating it, and a dispatch lost AFTER
  // a long queue wait still draws the corrective. A hard ceiling turns a wedged queue
  // into telemetry rather than silent abandonment.
  const liveCeiling = attempts * 30;
  let misses = 0;
  let ticks = 0;
  for (; misses < attempts && ticks < liveCeiling; ticks++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const latest = await getLatestFlowTaskForRun(db, flowRunId);
    // A NEW task means the dispatch reached the agent — from here its turn has the
    // normal surfaces (start chunk clears the toast; a later failure parks visibly).
    if (latest && latest.id !== before?.id) return;
    if (await ops.hasLiveFlowAdmission(flowRunId)) continue;
    misses++;
    const run = await getFlowRun(db, flowRunId);
    if (!run || ['failed', 'cancelled', 'completed'].includes(run.status)) {
      // A Cancel that dropped the queued continuation ended it on purpose.
      if (droppedSinceStaged(entry)) return;
      captureFlowAdmissionException(
        new Error(`Continuation dispatch lost for flow run ${flowRunId}`),
        'continuation-dispatch',
      );
      entry.emitCorrective(CONTINUATION_CORRECTIVE_MESSAGE);
      return;
    }
  }
  if (ticks >= liveCeiling) {
    captureFlowAdmissionException(
      new Error(`Continuation for flow run ${flowRunId} still queued when its watch expired`),
      'continuation-watch-expired',
    );
  }
}
