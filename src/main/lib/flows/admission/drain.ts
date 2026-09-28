import log from 'electron-log';
import type { FlowAdmissionController } from '.';
import { captureFlowAdmissionException } from './activity';
import { admissionDrainFrozen } from './config';

// A failed drain pass retries on this schedule, then stops: the bound is explicit so a persistent
// fault can never spin. One Sentry capture per failure episode; a successful pass ends the episode.
export const FLOW_ADMISSION_DRAIN_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

type ClaimResult = Awaited<ReturnType<FlowAdmissionController['claimEligible']>>;

export type FlowAdmissionDrainOps = {
  claimEligible: () => Promise<ClaimResult>;
  dispatchClaim: (ticket: number) => Promise<void>;
  notifyFailedStartAdmission: (admission: ClaimResult['failed'][number]) => Promise<void>;
};

export type FlowAdmissionDrainer = {
  drain: () => Promise<void>;
  kickIfStalled: () => void;
  reset: () => void;
};

/** Serialises admission drain passes and owns their bounded retry after a failed pass. */
export function createFlowAdmissionDrainer(ops: FlowAdmissionDrainOps): FlowAdmissionDrainer {
  let drainPromise: Promise<void> | null = null;
  let drainRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let stalled = false;
  // Claimed tickets whose dispatch threw. `claimed` occupies capacity and claimEligible never
  // selects it again, so without this a retry could not reach them until the next launch's recovery.
  const strandedClaims = new Set<number>();

  async function dispatchStrandedClaims(errors: unknown[]): Promise<void> {
    // No state pre-read: dispatch only promotes a row that is still `claimed` (one CAS in
    // beginAdmissionDispatch), so a ticket cancelled or settled since is a no-op here.
    for (const ticket of [...strandedClaims]) {
      if (await attempt(errors, () => ops.dispatchClaim(ticket))) strandedClaims.delete(ticket);
    }
  }

  /** Records a failure instead of throwing, so one bad ticket cannot stop the rest of a batch. */
  async function attempt(errors: unknown[], run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  }

  /** Claims and dispatches one batch; true when more eligible work may remain. */
  async function drainBatch(errors: unknown[]): Promise<boolean> {
    const claimed = await ops.claimEligible();
    for (const failed of claimed.failed) {
      await attempt(errors, () => ops.notifyFailedStartAdmission(failed));
    }
    for (const { ticket } of claimed.admissions) {
      // A claim whose dispatch threw stays `claimed`; keep it for the next pass to re-dispatch.
      if (!(await attempt(errors, () => ops.dispatchClaim(ticket)))) strandedClaims.add(ticket);
    }
    return claimed.hasMore && claimed.candidatesProcessed > 0;
  }

  async function drainPass(): Promise<void> {
    const errors: unknown[] = [];
    await dispatchStrandedClaims(errors);
    while (drainRequested && errors.length === 0) {
      drainRequested = false;
      while ((await drainBatch(errors)) && errors.length === 0);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Flow admission drain pass failed');
  }

  async function drainPasses(): Promise<void> {
    try {
      await drainPass();
    } catch (error) {
      // A trigger that arrived mid-pass had its request consumed by this failing pass; restore it
      // so the next chained pass does real work instead of resolving as a no-op.
      drainRequested = true;
      throw error;
    }
  }

  function clearRetry(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(delayMs: number): void {
    if (retryTimer || admissionDrainFrozen()) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!admissionDrainFrozen()) void drain();
    }, delayMs);
    retryTimer.unref?.();
  }

  function onSucceeded(): void {
    clearRetry();
    failures = 0;
    stalled = false;
  }

  function onFailed(error: unknown): void {
    failures += 1;
    if (failures === 1) captureFlowAdmissionException(error, 'queue-drain');
    const delayMs = FLOW_ADMISSION_DRAIN_RETRY_DELAYS_MS[failures - 1];
    if (delayMs === undefined) {
      stalled = true;
      log.error('[FlowAdmission] queue drain failed; retries exhausted', {
        attempts: failures,
        error,
      });
      return;
    }
    log.warn('[FlowAdmission] queue drain failed; retrying', { attempt: failures, delayMs, error });
    scheduleRetry(delayMs);
  }

  function drain(): Promise<void> {
    if (admissionDrainFrozen()) return Promise.resolve();
    drainRequested = true;
    const previous = drainPromise?.catch(() => undefined) ?? Promise.resolve();
    const current = previous.then(drainPasses);
    drainPromise = current;
    void current
      .finally(() => {
        if (drainPromise === current) drainPromise = null;
      })
      .then(onSucceeded, onFailed);
    return current;
  }

  return {
    drain,
    kickIfStalled: () => {
      if (stalled) void drain();
    },
    reset: () => {
      drainPromise = null;
      drainRequested = false;
      clearRetry();
      failures = 0;
      stalled = false;
      strandedClaims.clear();
    },
  };
}
