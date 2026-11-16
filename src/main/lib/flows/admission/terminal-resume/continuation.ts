import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import type { FlowResumeTicketAction } from '../../../../../shared/lib/flow-admission';
import type { RecoveryKind } from '../../../../../shared/types/flow-run/resume';
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
  /** The label the user clicked; unset for a typed reply or boot carry-on (the claim decides). */
  kind?: RecoveryKind;
  /** A paused run only: the Runs-panel action its claim replays. */
  action?: FlowResumeTicketAction;
  /** Checked inside the enqueue transaction, so a Cancel that lands first wins by construction. */
  admit?: (db: Db) => boolean;
};

type ContinuationWatch = { intervalMs?: number; attempts?: number };

/** Injected by runtime's lifecycle hook — the only caller — to keep this module cycle-free. */
type ContinuationAdmissionOps = {
  requestTerminalFlowResume: (input: PendingContinuationResume) => Promise<object>;
  hasLiveFlowAdmission: (flowRunId: string) => Promise<boolean>;
  /** State of the run's live admission row, or null when none — the fire pre-flight. A release that
   * kept a cleanup error reads `retained`: it never settles on its own, so nothing would fire a stage. */
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
  'Use Continue or Retry above the composer to pick this flow back up.';

const LIVE_TASK_STATUSES = ['pending', 'running'];
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
): StagedContinuation | null {
  const earlier = staged.get(pending.flowRunId)?.pending;
  // A staged Runs-panel action is the user's explicit choice: a later stage never replaces it, and
  // says so rather than dropping silently.
  if (earlier?.action && earlier.action !== pending.action) {
    emitCorrective(CONTINUATION_CORRECTIVE_MESSAGE);
    return null;
  }
  // A later stage for the same run (a typed reply or Continue after boot carry-on) must keep the
  // earlier abandon guard beside its own.
  const earlierAdmit = earlier?.admit;
  const ownAdmit = pending.admit;
  const admit =
    ownAdmit && earlierAdmit
      ? (db: Db) => ownAdmit(db) && earlierAdmit(db)
      : (ownAdmit ?? earlierAdmit);
  const generation = dropGenerations.get(pending.flowRunId) ?? 0;
  const entry = { pending: { ...pending, admit }, emitCorrective, watch, generation };
  staged.set(pending.flowRunId, entry);
  return entry;
}

export const ALREADY_RESUMING_MESSAGE = 'This run is already resuming.';
const alreadyResuming = () =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: ALREADY_RESUMING_MESSAGE });

const RETAINED_RELEASE_MESSAGE =
  'This run is still holding its slot after a failed cleanup — restart Frink to recover it.';

const holdsSlot = (state: string | null) => state === 'active' || state === 'releasing';

/** A click on a run still holding its slot (active, or releasing it) would be refused as a second
 * admission, so it is staged for that slot's settle to enqueue. False when no slot is held: enqueue directly.
 * `behindRelease`: a paused run's resume waits only on a release; an active slot means one already won. */
export async function stageBehindHeldAdmission(
  pending: PendingContinuationResume,
  ops: ContinuationAdmissionOps,
  behindRelease = false,
): Promise<boolean> {
  const { flowRunId } = pending;
  const held = await ops.getLiveAdmissionState(flowRunId);
  if (held === 'retained') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: RETAINED_RELEASE_MESSAGE });
  }
  if (behindRelease && held === 'active') throw alreadyResuming();
  if (!holdsSlot(held)) {
    // An entry the settle missed has no admission left to fire it: drop it, so it cannot fire
    // after the run this click re-admits.
    if (held === null && staged.has(flowRunId)) dropStagedContinuation(flowRunId);
    return false;
  }
  // A click of another action than the one already staged is refused, as a live ticket refuses it.
  const earlier = staged.get(flowRunId)?.pending;
  if (earlier && earlier.action !== pending.action) throw alreadyResuming();
  const entry = stageContinuationResume(pending, (message) => {
    log.warn('[Flow Admission] staged recovery failed', { flowRunId, message });
    captureFlowAdmissionException(new Error(message), 'recovery-stage');
  });
  const after = await ops.getLiveAdmissionState(flowRunId);
  // Another resume claimed the slot while this one staged: it would only fire on a later park.
  if (behindRelease && after === 'active' && staged.get(flowRunId) === entry) {
    staged.delete(flowRunId);
    throw alreadyResuming();
  }
  if (after === 'retained') {
    // The release kept a cleanup error after the probe: its cleanup fire may already have run, so
    // nothing would fire this stage — refuse the click as the up-front check does.
    staged.delete(flowRunId);
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: RETAINED_RELEASE_MESSAGE });
  }
  // The held admission may have settled between the probe and the stage, leaving no settle to
  // fire the entry: fire it here (it enqueues on a free run and steps aside for a newer ticket).
  // Nothing would re-fire it after a failed read, so the click un-stages and rejects instead.
  try {
    if (!holdsSlot(after)) await fireStaged(flowRunId, ops);
  } catch (error) {
    staged.delete(flowRunId);
    throw error;
  }
  return true;
}

/** The Runs-panel action staged for this run, which a typed reply must not stand in for. */
export const stagedResumeAction = (flowRunId: string) => staged.get(flowRunId)?.pending.action;

/** A continuation waits in memory for the run's held admission to settle; the row reads it as queued. */
export function hasStagedContinuation(flowRunId: string): boolean {
  return staged.has(flowRunId);
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
  return { ...pending, admit };
}

type SettleController = Pick<FlowAdmissionController, 'settle' | 'settleWithContinuation'>;
type SettleOutcome = Parameters<FlowAdmissionController['settle']>[1];

/**
 * Settle the prior admission and enqueue the run's staged continuation in ONE transaction, so the
 * freed slot cannot go to a queued start first. False when nothing settled (the entry stays staged).
 */
export async function settleWithStagedContinuation(
  controller: SettleController,
  ticket: number,
  outcome: SettleOutcome,
  flowRunId: string,
  ops: ContinuationAdmissionOps,
): Promise<boolean> {
  const entry = staged.get(flowRunId);
  const settled = entry
    ? await settleConsuming(controller, ticket, outcome, entry, ops)
    : (await controller.settle(ticket, outcome)) !== null;
  // A click staged while the settle awaited missed the read above, and its own re-probe still saw
  // the slot held: fire it now the run is free (a no-op when nothing is staged).
  if (settled) await fireStagedContinuationResume(flowRunId, ops);
  return settled;
}

async function settleConsuming(
  controller: SettleController,
  ticket: number,
  outcome: SettleOutcome,
  entry: StagedContinuation,
  ops: ContinuationAdmissionOps,
): Promise<boolean> {
  const { flowRunId } = entry.pending;
  // The entry leaves the map only once the settle committed: a thrown transaction keeps it staged.
  const result = await controller.settleWithContinuation(ticket, outcome, continuationInput(entry));
  if (!result.settled) return false;
  // Only this entry is consumed: a newer stage that landed during the await is fired after.
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
 * mints a new flow task and its turn's start chunk clears the optimistic toast. A failed
 * pre-flight read keeps the entry staged for a later fire.
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
  try {
    await fireStaged(flowRunId, ops);
  } catch (error) {
    // A caller's committed settle must not fail on this read. The entry stays staged for a
    // later fire (the reconcile hook re-fires it), so no corrective: it is not lost yet.
    log.warn('[Flow Admission] staged continuation fire pre-flight failed', { flowRunId, error });
    captureFlowAdmissionException(error, 'continuation-fire-preflight');
  }
}

/** The fire itself. Its one unguarded await is the pre-flight read, before the entry leaves the map. */
async function fireStaged(flowRunId: string, ops: ContinuationAdmissionOps): Promise<void> {
  const entry = staged.get(flowRunId);
  if (!entry) return;
  const liveState = await ops.getLiveAdmissionState(flowRunId);
  // A retained release keeps the entry too: the cleanup-failure fire above abandons it visibly, and a
  // click staged after that fire is refused by stageBehindHeldAdmission's own retained re-probe.
  if (liveState === 'releasing' || liveState === 'retained') {
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

type WatchedTask = { id: string; status: string } | null | undefined;

const reachedAgent = (latest: WatchedTask, before: WatchedTask): boolean =>
  !!latest && (latest.id !== before?.id || LIVE_TASK_STATUSES.includes(latest.status));

/** No admission left to dispatch it: the run settled, or a paused run's task is still parked. */
function continuationLost(run: { status: string } | null | undefined, latest: WatchedTask) {
  if (!run || ['failed', 'cancelled', 'completed'].includes(run.status)) return true;
  return run.status === 'paused' && latest?.status === 'needs_attention';
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
    // A NEW task, or a paused run's own task picked back up, means the dispatch reached the agent;
    // its turn owns the surfaces from here (start chunk clears the toast, a failure parks).
    if (reachedAgent(latest, before)) return;
    if (await ops.hasLiveFlowAdmission(flowRunId)) continue;
    misses++;
    if (continuationLost(await getFlowRun(db, flowRunId), latest)) {
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
