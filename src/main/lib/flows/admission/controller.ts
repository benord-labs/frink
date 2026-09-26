import { Mutex } from 'async-mutex';
import type { FlowAdmissionState } from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import {
  type FlowAdmissionConfig,
  type FlowAdmissionConfigPatch,
  readFlowAdmissionConfig,
  updateFlowAdmissionConfig,
} from './config';
import { type MoveQueuedAdmissionResult, moveQueuedAdmission } from './queue-order';
import { recoveryAdmissions } from './recovery-store';
import {
  type EnqueueFlowStartInput,
  type EnqueueFlowStartResult,
  enqueueFlowStart,
} from './start-store';
import {
  admissionByTicket,
  admissionStateCounts,
  beginAdmissionDispatch,
  type ClaimEligibleAdmissionsResult,
  cancelAdmission,
  claimEligibleAdmissions,
  type EnqueueFlowAdmissionInput,
  type EnqueueFlowAdmissionResult,
  enqueueFlowAdmission,
  type FlowRunAdmission,
  liveAdmissionForRun,
  pruneSettledAdmissions,
  transitionAdmission,
} from './store';
import {
  type EnqueueTerminalFlowResumeInput,
  enqueueTerminalFlowResume,
  TerminalResumeAdmissionError,
} from './terminal-resume/resume-store';

type Db = ReturnType<typeof getDatabase>;
type ConfigReader = () => Promise<FlowAdmissionConfig>;
type ConfigWriter = (patch: FlowAdmissionConfigPatch) => Promise<FlowAdmissionConfig>;
type SettleOutcome = Extract<FlowAdmissionState, 'released' | 'failed' | 'cancelled'>;

const FLOW_ADMISSION_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const UNDISPATCHED_ADMISSION_STATES: readonly FlowAdmissionState[] = ['queued', 'claimed'];

export type CancelAdmissionGuard = {
  /** Admission states the cancellation may act on. Defaults to every undispatched state. */
  states?: readonly FlowAdmissionState[];
  /** When set, the run's live admission must still be this exact ticket. */
  ticket?: number;
};

let controllerMutex = new Mutex();

const copyConfig = (config: FlowAdmissionConfig): FlowAdmissionConfig => ({ ...config });

export class FlowAdmissionController {
  private configSnapshot: FlowAdmissionConfig | null = null;

  constructor(
    private readonly db: Db,
    private readonly readConfig: ConfigReader = readFlowAdmissionConfig,
    private readonly writeConfig: ConfigWriter = updateFlowAdmissionConfig,
  ) {}

  private immediate<T>(operation: () => T): T {
    return this.db.transaction(operation, { behavior: 'immediate' });
  }

  /** Caller must hold controllerMutex across both the read and snapshot assignment. */
  private async effectiveConfigLocked(): Promise<FlowAdmissionConfig> {
    if (this.configSnapshot) return copyConfig(this.configSnapshot);
    const config = await this.readConfig();
    this.configSnapshot = copyConfig(config);
    return copyConfig(config);
  }

  private async replaceConfigSnapshot(
    load: () => Promise<FlowAdmissionConfig>,
  ): Promise<FlowAdmissionConfig> {
    return controllerMutex.runExclusive(async () => {
      const config = await load();
      this.configSnapshot = copyConfig(config);
      return copyConfig(config);
    });
  }

  async refreshConfig(): Promise<FlowAdmissionConfig> {
    return this.replaceConfigSnapshot(this.readConfig);
  }

  async updateConfig(patch: FlowAdmissionConfigPatch): Promise<FlowAdmissionConfig> {
    return this.replaceConfigSnapshot(() => this.writeConfig(patch));
  }

  async enqueue(input: EnqueueFlowAdmissionInput): Promise<EnqueueFlowAdmissionResult> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() => enqueueFlowAdmission(this.db, input)),
    );
  }

  async enqueueStart(input: EnqueueFlowStartInput): Promise<EnqueueFlowStartResult> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() => enqueueFlowStart(this.db, input)),
    );
  }

  async enqueueTerminalResume(
    input: EnqueueTerminalFlowResumeInput,
  ): Promise<EnqueueFlowAdmissionResult> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() =>
        enqueueTerminalFlowResume(this.db, input, {
          live: liveAdmissionForRun,
          enqueue: enqueueFlowAdmission,
        }),
      ),
    );
  }

  async getLiveForRun(flowRunId: string): Promise<FlowRunAdmission | null> {
    return controllerMutex.runExclusive(() => liveAdmissionForRun(this.db, flowRunId));
  }

  async getByTicket(ticket: number): Promise<FlowRunAdmission | null> {
    return controllerMutex.runExclusive(() => admissionByTicket(this.db, ticket));
  }

  async moveQueued(ticket: number, targetTicket: number): Promise<MoveQueuedAdmissionResult> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() => moveQueuedAdmission(this.db, ticket, targetTicket)),
    );
  }

  /**
   * `guard` narrows what may be cancelled, revalidated inside the admission transaction so a
   * concurrent claim cannot slip past the caller's read. Omitted, it keeps the historical
   * contract: cancel any undispatched admission for the run.
   */
  async cancelUndispatchedForRun(
    flowRunId: string,
    now = new Date(),
    guard?: CancelAdmissionGuard,
  ): Promise<FlowRunAdmission | null> {
    const states = guard?.states ?? UNDISPATCHED_ADMISSION_STATES;
    return controllerMutex.runExclusive(() =>
      this.immediate(() => {
        const admission = liveAdmissionForRun(this.db, flowRunId);
        if (!admission || !states.includes(admission.state)) return null;
        // Tickets are immutable identities, runs are not: a run whose ticket settled can hold a
        // fresh admission by the time this transaction opens. Cancelling by run alone would let a
        // stale click destroy that replacement, so the caller's ticket must still be the live one.
        if (guard?.ticket !== undefined && admission.ticket !== guard.ticket) return null;
        return cancelAdmission(this.db, admission.ticket, now);
      }),
    );
  }

  async claimEligible(now = new Date()): Promise<ClaimEligibleAdmissionsResult> {
    return controllerMutex.runExclusive(async () => {
      const config = await this.effectiveConfigLocked();
      return this.immediate(() => claimEligibleAdmissions(this.db, config, now));
    });
  }

  async beginDispatch(ticket: number, now = new Date()): Promise<FlowRunAdmission | null> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() => beginAdmissionDispatch(this.db, ticket, now)),
    );
  }

  async beginRelease(ticket: number): Promise<FlowRunAdmission | null> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() =>
        transitionAdmission(this.db, ticket, ['active'], { state: 'releasing', error: null }),
      ),
    );
  }

  /** The inverse of beginRelease: a release the dead process never finished hands the slot back to its live run. */
  async reactivate(ticket: number): Promise<FlowRunAdmission | null> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() =>
        transitionAdmission(this.db, ticket, ['releasing'], { state: 'active', error: null }),
      ),
    );
  }

  async recordReleaseFailure(ticket: number, error: string): Promise<FlowRunAdmission | null> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() =>
        transitionAdmission(this.db, ticket, ['releasing'], { error: error.slice(0, 2_000) }),
      ),
    );
  }

  async settle(
    ticket: number,
    outcome: SettleOutcome,
    error: string | null = null,
    now = new Date(),
  ): Promise<FlowRunAdmission | null> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() =>
        transitionAdmission(this.db, ticket, ['releasing'], {
          state: outcome,
          error: error?.slice(0, 2_000) ?? null,
          settledAt: now,
        }),
      ),
    );
  }

  /**
   * Settle and enqueue a continuation in ONE transaction, so the freed slot is already claimed by a
   * resume ticket before any drain can hand it to a queued start. A declined admit keeps the settle.
   */
  async settleWithContinuation(
    ticket: number,
    outcome: SettleOutcome,
    resume: EnqueueTerminalFlowResumeInput,
    now = new Date(),
  ): Promise<{ settled: boolean; declined: TerminalResumeAdmissionError | null }> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() => {
        const settled = transitionAdmission(this.db, ticket, ['releasing'], {
          state: outcome,
          error: null,
          settledAt: now,
        });
        if (!settled) return { settled: false, declined: null };
        try {
          enqueueTerminalFlowResume(this.db, resume, {
            live: liveAdmissionForRun,
            enqueue: enqueueFlowAdmission,
          });
          return { settled: true, declined: null };
        } catch (error) {
          if (error instanceof TerminalResumeAdmissionError)
            return { settled: true, declined: error };
          throw error;
        }
      }),
    );
  }

  async requestCancellation(ticket: number, now = new Date()): Promise<FlowRunAdmission | null> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() => cancelAdmission(this.db, ticket, now)),
    );
  }

  async recoverySnapshot(
    afterTicket = 0,
    limit = 100,
  ): Promise<ReturnType<typeof recoveryAdmissions>> {
    return controllerMutex.runExclusive(() =>
      this.immediate(() => recoveryAdmissions(this.db, afterTicket, limit)),
    );
  }

  async getSnapshot(): Promise<{
    config: FlowAdmissionConfig;
    counts: Record<FlowAdmissionState, number>;
    occupied: number;
    draining: boolean;
  }> {
    return controllerMutex.runExclusive(async () => {
      const config = await this.effectiveConfigLocked();
      const counts = admissionStateCounts(this.db);
      const occupied = counts.claimed + counts.active + counts.releasing;
      return {
        config,
        counts,
        occupied,
        draining: config.concurrencyLimitEnabled && occupied > config.maxConcurrentRuns,
      };
    });
  }

  async pruneExpiredHistory(
    before = new Date(Date.now() - FLOW_ADMISSION_TERMINAL_RETENTION_MS),
    limit = 100,
  ) {
    return controllerMutex.runExclusive(() =>
      this.immediate(() => pruneSettledAdmissions(this.db, before, limit)),
    );
  }
}

export function _resetFlowAdmissionControllerMutexForTests(): void {
  controllerMutex = new Mutex();
}
