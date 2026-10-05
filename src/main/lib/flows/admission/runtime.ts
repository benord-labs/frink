import log from 'electron-log';
import {
  FLOW_ADMISSION_LIVE_STATES,
  isFlowAdmissionIntentV1,
} from '../../../../shared/lib/flow-admission';
import { getDatabase } from '../../db';
import { getFlowRun, setFlowRunStatus } from '../../db/repos/flow-runs';
import { getVersion } from '../../db/repos/flow-versions';
import { getFlowById } from '../../db/repos/flows';
import { cancelRemainingNodeRunsForRun } from '../../db/repos/node-runs';
import { cancelFlowLinkedTasksForRun } from '../../db/repos/tasks';
import { emitRunTerminal } from '../event-emit';
import {
  type CancelAdmissionGuard,
  type EnqueueFlowStartInput,
  type EnqueueFlowStartResult,
  FlowAdmissionController,
} from '.';
import {
  captureFlowAdmissionException,
  hasFlowResourceActivity,
  setFlowAdmissionLifecycleHooks,
  settleStageAfterUnpromotedRetry,
  withFlowResourceCleanup,
} from './activity';
import type { FlowAdmissionConfigPatch } from './config';
import { createFlowAdmissionDrainer } from './drain';
import {
  type AdmissionOutcome,
  beginTerminalRelease,
  outcomeForRunStatus,
  recoverReleasingAdmission,
} from './recovery-store';
import type { FlowRunAdmission } from './store';
import {
  fireStagedContinuationResume,
  settleWithStagedContinuation,
} from './terminal-resume/continuation';
import {
  type EnqueueTerminalFlowResumeInput,
  type TerminalFlowResumeIntent,
  terminalFlowResumeIntent,
  terminalResumeAdmissionError,
} from './terminal-resume/resume-store';

let controller: FlowAdmissionController | null = null;
type AdmittedDispatcher<T> = (admitted: T, ticket: number) => Promise<void>;
let dispatchStartedFlow: AdmittedDispatcher<string> | null = null;
let dispatchResumedFlow: AdmittedDispatcher<TerminalFlowResumeIntent> | null = null;

const admissionController = (): FlowAdmissionController =>
  (controller ??= new FlowAdmissionController(getDatabase()));

const cleanupErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function emitAdmissionRunFailed(flowRunId: string, summary: string): Promise<void> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run) return;
  const version = await getVersion(db, run.flowVersionId);
  if (!version) return;
  const flow = await getFlowById(db, version.flowId);
  if (!flow) return;
  emitRunTerminal(
    { flowId: flow.id, flowName: flow.name, batchId: run.batchId ?? undefined },
    flowRunId,
    'failed',
    { summary },
  );
}

async function notifyFailedAdmission(
  admission: Awaited<ReturnType<FlowAdmissionController['getByTicket']>>,
): Promise<void> {
  if (admission?.state !== 'failed') return;
  if (admission.priorityClass === 'start') {
    await emitAdmissionRunFailed(admission.flowRunId, admission.error ?? 'Flow admission failed');
    return;
  }
  await settleStageAfterUnpromotedRetry(admission.flowRunId);
}

async function failStartedAdmission(flowRunId: string, error: unknown): Promise<void> {
  const db = getDatabase();
  const message = cleanupErrorText(error);
  const failed = await setFlowRunStatus(
    db,
    flowRunId,
    'failed',
    { completedAt: new Date() },
    'running',
  );
  if (failed) {
    await cancelRemainingNodeRunsForRun(db, flowRunId);
    await cancelFlowLinkedTasksForRun(db, flowRunId);
    await requestFlowAdmissionRelease(flowRunId);
    await emitAdmissionRunFailed(flowRunId, message);
  } else {
    await requestFlowAdmissionRelease(flowRunId);
  }
  captureFlowAdmissionException(error, 'admitted-dispatch');
  log.error('[FlowAdmission] admitted dispatch failed', { flowRunId, error });
}

type LiveAdmission = Awaited<ReturnType<FlowAdmissionController['getLiveForRun']>>;

// These pre-resume names are claim-oriented in practice: start and resume admissions share the
// same dispatchability check, failure transition, and non-dispatchable release path.
const isDispatchableStartedAdmission = (
  live: LiveAdmission,
  ticket: number,
  runStatus: string | undefined,
): boolean => live?.ticket === ticket && live.state === 'active' && runStatus === 'running';

async function releaseNonDispatchableStartedAdmission(
  flowRunId: string,
  ticket: number,
  live: LiveAdmission,
  runStatus: string | undefined,
): Promise<void> {
  const message = 'Flow admission claim was not dispatchable';
  // A Cancel that committed after promotion is the user's call, not a fault.
  if (runStatus !== 'cancelled')
    captureFlowAdmissionException(new Error(message), 'non-dispatchable-claim');
  log.warn(`[FlowAdmission] ${message}; releasing the lease`, {
    flowRunId,
    ticket,
    liveTicket: live?.ticket,
    liveState: live?.state,
    runStatus,
  });
  if (live?.ticket === ticket && live.state === 'active') {
    await requestFlowAdmissionRelease(flowRunId, ticket);
    if (await admissionController().settle(ticket, 'failed', message)) {
      await drainFlowAdmissions();
    }
  }
}

async function executeStartedAdmission(flowRunId: string, ticket: number): Promise<void> {
  if (!dispatchStartedFlow) throw new Error('Flow admission start dispatcher is not registered');
  const [live, run] = await Promise.all([
    admissionController().getLiveForRun(flowRunId),
    getFlowRun(getDatabase(), flowRunId),
  ]);
  if (!isDispatchableStartedAdmission(live, ticket, run?.status)) {
    await releaseNonDispatchableStartedAdmission(flowRunId, ticket, live, run?.status);
    return;
  }
  await dispatchStartedFlow(flowRunId, ticket);
}

async function executeResumedAdmission(flowRunId: string, ticket: number): Promise<void> {
  if (!dispatchResumedFlow) throw new Error('Flow admission resume dispatcher is not registered');
  const [live, run] = await Promise.all([
    admissionController().getLiveForRun(flowRunId),
    getFlowRun(getDatabase(), flowRunId),
  ]);
  if (!isDispatchableStartedAdmission(live, ticket, run?.status)) {
    await releaseNonDispatchableStartedAdmission(flowRunId, ticket, live, run?.status);
    return;
  }
  const intent = terminalFlowResumeIntent(live?.intentJson);
  if (!intent) throw new Error(`Flow admission ${ticket} has no terminal resume node reference`);
  await dispatchResumedFlow(intent, ticket);
}

export function registerFlowAdmissionStartDispatcher(dispatcher: AdmittedDispatcher<string>): void {
  dispatchStartedFlow = dispatcher;
}

export function registerTerminalFlowResumeDispatcher(
  dispatcher: AdmittedDispatcher<TerminalFlowResumeIntent>,
): void {
  dispatchResumedFlow = dispatcher;
}

async function dispatchClaim(ticket: number): Promise<void> {
  const active = await admissionController().beginDispatch(ticket);
  if (!active) {
    await notifyFailedAdmission(await admissionController().getByTicket(ticket));
    return;
  }
  const intent = isFlowAdmissionIntentV1(active.intentJson) ? active.intentJson : null;
  const resumeIntent = terminalFlowResumeIntent(intent);
  if (!intent || (intent.action === 'resume' && !resumeIntent)) {
    const message = `Flow admission ${active.ticket} has an unsupported activation intent`;
    captureFlowAdmissionException(new Error(message), 'unsupported-activation-intent');
    await admissionController().beginRelease(active.ticket);
    await admissionController().settle(active.ticket, 'failed', message);
    log.error('[FlowAdmission] unsupported activation was not dispatched', {
      ticket: active.ticket,
      flowRunId: active.flowRunId,
      error: message,
    });
    void drainFlowAdmissions();
    return;
  }
  void withFlowResourceCleanup(active.flowRunId, async () => {
    try {
      if (intent.action === 'start') {
        await executeStartedAdmission(active.flowRunId, active.ticket);
      } else {
        await executeResumedAdmission(active.flowRunId, active.ticket);
      }
    } catch (error) {
      await failStartedAdmission(active.flowRunId, error);
    }
  }).catch((error) => {
    log.error('[FlowAdmission] failed to record admitted dispatch failure', {
      flowRunId: active.flowRunId,
      error,
    });
    captureFlowAdmissionException(error, 'dispatch-cleanup');
  });
}

const drainer = createFlowAdmissionDrainer({
  claimEligible: () => admissionController().claimEligible(),
  dispatchClaim,
  notifyFailedAdmission,
});

export function drainFlowAdmissions(): Promise<void> {
  return drainer.drain();
}

/** Runs a Flow-run command under the admission mutex; see FlowAdmissionController.transition. */
export function transitionFlowRun<T>(
  command: () => T,
  afterCommit?: (result: T) => undefined,
): Promise<T> {
  return admissionController().transition(command, afterCommit);
}

/** Re-drains a queue whose retries ran out; a no-op otherwise. Safe to call from a poll. */
export function kickStalledFlowAdmissionDrain(): void {
  drainer.kickIfStalled();
}

export type FlowAdmissionSettings = {
  queue_paused: boolean;
  concurrency_limit_enabled: boolean;
  max_concurrent_runs: number;
  occupied_runs: number;
  queued_runs: number;
  draining: boolean;
};

const toFlowAdmissionSettings = (
  snapshot: Awaited<ReturnType<FlowAdmissionController['getSnapshot']>>,
): FlowAdmissionSettings => ({
  queue_paused: snapshot.config.queuePaused,
  concurrency_limit_enabled: snapshot.config.concurrencyLimitEnabled,
  max_concurrent_runs: snapshot.config.maxConcurrentRuns,
  occupied_runs: snapshot.occupied,
  queued_runs: snapshot.counts.queued,
  draining: snapshot.draining,
});

export async function getFlowAdmissionSettings(): Promise<FlowAdmissionSettings> {
  return toFlowAdmissionSettings(await admissionController().getSnapshot());
}

export async function updateFlowAdmissionSettings(
  patch: FlowAdmissionConfigPatch,
): Promise<FlowAdmissionSettings> {
  await admissionController().updateConfig(patch);
  await drainFlowAdmissions().catch(() => undefined);
  return getFlowAdmissionSettings();
}

export async function moveQueuedFlowAdmission(ticket: number, targetTicket: number) {
  return admissionController().moveQueued(ticket, targetTicket);
}

export async function requestFlowStart(
  input: EnqueueFlowStartInput,
): Promise<EnqueueFlowStartResult> {
  const result = await admissionController().enqueueStart(input);
  // The start is durably queued; a drain fault is retried by the drain itself, so failing here
  // would report a start that is about to run as an error.
  await drainFlowAdmissions().catch((error) => {
    log.warn('[FlowAdmission] drain after start failed', { flowRunId: result.run.id, error });
  });
  const run = await getFlowRun(getDatabase(), result.run.id);
  return { ...result, run: run ?? result.run };
}

export async function requestTerminalFlowResume(
  input: EnqueueTerminalFlowResumeInput,
): Promise<Awaited<ReturnType<FlowAdmissionController['enqueueTerminalResume']>>> {
  const result = await admissionController().enqueueTerminalResume(input);
  if (!result.created && result.admission.state === 'claimed') {
    try {
      await dispatchClaim(result.admission.ticket);
    } finally {
      await drainFlowAdmissions();
    }
  } else {
    await drainFlowAdmissions();
  }
  const admission = await admissionController().getByTicket(result.admission.ticket);
  if (admission?.state === 'failed' || admission?.state === 'cancelled') {
    throw terminalResumeAdmissionError(
      admission.error ?? `Flow resume admission ${admission.state} before dispatch`,
    );
  }
  return { ...result, admission: admission ?? result.admission };
}

export async function cancelUndispatchedFlowAdmission(
  flowRunId: string,
  guard?: CancelAdmissionGuard,
): Promise<boolean> {
  const cancelled = await admissionController().cancelUndispatchedForRun(
    flowRunId,
    new Date(),
    guard,
  );
  if (!cancelled) return false;
  // The cancellation has committed; the drain only re-fills the freed slot. Rejecting here would
  // report a removal that already happened as a failure; the drain captures and retries itself.
  await drainFlowAdmissions().catch((error) => {
    log.warn('[FlowAdmission] drain after dequeue failed', { flowRunId, error });
  });
  return true;
}

/**
 * True while a resume/start admission for this run is anywhere in its live lifecycle —
 * `queued` behind the concurrency cap, `claimed` awaiting dispatch, `active`, or
 * `releasing` mid-teardown — i.e. NOT yet a failure. `enqueueTerminalFlowResume` does not throw when the cap is
 * full; it returns `queued` and the run's own status stays terminal until claim/promote,
 * so a caller inferring failure from run status alone (no new task, still failed/cancelled)
 * cannot tell a queued continuation from a lost one without checking this.
 */
export async function hasLiveFlowAdmission(flowRunId: string): Promise<boolean> {
  const live = await admissionController().getLiveForRun(flowRunId);
  return live !== null && (FLOW_ADMISSION_LIVE_STATES as readonly string[]).includes(live.state);
}

/** ONE read: `queuedResume` = a resume ticket (queued/claimed/releasing) already owns the run's continuation. */
export async function probeFlowAdmission(
  flowRunId: string,
): Promise<{ active: boolean; queuedResume: boolean }> {
  const live = await admissionController().getLiveForRun(flowRunId);
  const active = live?.state === 'active';
  return { active, queuedResume: !active && live?.priorityClass === 'resume' };
}

export async function hasActiveFlowAdmission(flowRunId: string): Promise<boolean> {
  const live = await admissionController().getLiveForRun(flowRunId);
  return live?.state === 'active';
}

export async function requestFlowAdmissionRelease(
  flowRunId: string,
  expectedTicket?: number,
): Promise<void> {
  const live = await admissionController().getLiveForRun(flowRunId);
  if (!live || (expectedTicket !== undefined && live.ticket !== expectedTicket)) return;
  if (live.state === 'active') await admissionController().beginRelease(live.ticket);
  await reconcileFlowAdmission(flowRunId, undefined, expectedTicket);
}

async function retainReleaseFailure(
  live: NonNullable<Awaited<ReturnType<FlowAdmissionController['getLiveForRun']>>>,
  error: unknown,
): Promise<void> {
  const releasing =
    live.state === 'active'
      ? ((await admissionController().beginRelease(live.ticket)) ?? live)
      : live;
  if (releasing.state === 'releasing') {
    await admissionController().recordReleaseFailure(releasing.ticket, cleanupErrorText(error));
  }
}

async function settleTerminalAdmission(
  releasing: FlowRunAdmission,
  flowRunId: string,
  outcome: AdmissionOutcome,
): Promise<void> {
  if (releasing.error || hasFlowResourceActivity(flowRunId)) return;
  const settled = await settleWithStagedContinuation(
    admissionController(),
    releasing.ticket,
    outcome,
    flowRunId,
    continuationOps,
  );
  if (!settled) return;
  // The settle is the release; the drain only re-fills the freed slot and captures and retries itself.
  await drainFlowAdmissions().catch((error) => {
    log.warn('[FlowAdmission] drain after settle failed', { flowRunId, error });
  });
}

async function reconcileFlowAdmission(
  flowRunId: string,
  cleanupError?: unknown,
  expectedTicket?: number,
): Promise<void> {
  const live = await admissionController().getLiveForRun(flowRunId);
  if (!live || (expectedTicket !== undefined && live.ticket !== expectedTicket)) return;

  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run) {
    await retainReleaseFailure(live, 'Flow run is missing');
    return;
  }
  // In 0.0.10, one admission covers the whole top-level Flow run, including durable pauses. Only a
  // terminal run may release after every activity owner reports successful cleanup.
  if (cleanupError !== undefined) {
    await retainReleaseFailure(live, cleanupError);
    return;
  }
  // Stale-read fast path only: the terminal decision is re-made inside the transaction below.
  if (!outcomeForRunStatus(run.status)) return;
  const release = await transitionFlowRun(() => beginTerminalRelease(db, live.ticket));
  if (release) await settleTerminalAdmission(release.releasing, flowRunId, release.outcome);
}

export async function recoverFlowAdmissions(): Promise<{
  queued: number;
  ambiguous: number;
}> {
  let afterTicket = 0;
  let queued = 0;
  let ambiguous = 0;
  let recovered = 0;
  for (;;) {
    const page = await admissionController().recoverySnapshot(afterTicket);
    if (page.nextTicket != null && page.nextTicket <= afterTicket) {
      captureFlowAdmissionException(
        new Error(`Recovery cursor did not advance from ${afterTicket} to ${page.nextTicket}`),
        'recovery-cursor',
      );
      log.error('[FlowAdmission] recovery cursor did not advance', {
        afterTicket,
        nextTicket: page.nextTicket,
      });
      break;
    }
    queued += page.autoDrainable.length;
    ambiguous += page.ambiguous.length;
    for (const row of page.ambiguous) {
      // Release recovered terminal rows, but never replay ambiguous begun work.
      if (row.state === 'active') await reconcileFlowAdmission(row.flowRunId);
      else if (
        row.state === 'releasing' &&
        (await recoverReleasingAdmission(getDatabase(), admissionController(), row))
      ) {
        recovered += 1;
      }
    }
    if (page.nextTicket == null) break;
    afterTicket = page.nextTicket;
  }
  if (ambiguous > recovered) {
    log.warn('[FlowAdmission] ambiguous activations require manual recovery', {
      ambiguous: ambiguous - recovered,
    });
  }
  await drainFlowAdmissions();
  return { queued, ambiguous };
}

export function _setFlowAdmissionControllerForTests(value: FlowAdmissionController | null): void {
  controller = value;
  drainer.reset();
}

const continuationOps = {
  requestTerminalFlowResume,
  hasLiveFlowAdmission,
  getLiveAdmissionState: async (id: string) =>
    (await admissionController().getLiveForRun(id))?.state ?? null,
};

setFlowAdmissionLifecycleHooks({
  // A settle enqueues the staged continuation itself; this call owns the non-settling branches.
  reconcile: async (flowRunId, cleanupError) => {
    try {
      await reconcileFlowAdmission(flowRunId, cleanupError);
    } finally {
      await fireStagedContinuationResume(flowRunId, continuationOps, cleanupError);
    }
  },
  requestRelease: requestFlowAdmissionRelease,
});
