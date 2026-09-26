import log from 'electron-log';
import type { FlowResourceActivityRelease } from '../../flows/admission/activity';
import { awaitBounded } from '../../provider/await-bounded';
import type { ClaudeSession } from '../claude-session-registry';
import { endSession, getSession, unregisterSessionIfOwned } from '../claude-session-registry';
import { logDroppedPendingWork } from './wake-hold-signal';
import type { WakePumpExit } from './wake-pump-types';

const CLAUDE_CLEANUP_STEP_TIMEOUT_MS = 5_000;

type PumpCleanupIo = {
  clearPendingApprovals: (reason: string, subChatId: string) => void;
  clearCurrentExecutionChat: (executionContextId: string) => void;
};

async function captureCleanupError(
  errors: unknown[],
  operation: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

function throwCleanupErrors(errors: unknown[], message: string): void {
  if (errors.length > 1) throw new AggregateError(errors, message);
  if (errors.length === 1) throw errors[0];
}

async function awaitCleanupStep(work: Promise<unknown>, label: string): Promise<void> {
  if (await awaitBounded(work, CLAUDE_CLEANUP_STEP_TIMEOUT_MS)) {
    const error = new Error(`Claude session cleanup timed out waiting for ${label}`);
    void import('../../sentry/init')
      .then(({ captureMainException }) => {
        captureMainException(error, {
          surface: 'claude-provider-cleanup',
          stage: 'timeout',
          step: label,
        });
      })
      .catch(() => {});
    throw error;
  }
}

/**
 * Dispose one exact session and wait until its active turn and provider iterator have settled.
 * Identity detachment happens synchronously before the first await so a successor can safely
 * register under the same chat id while the old provider acknowledges shutdown.
 */
export async function disposeClaudeSessionAndWait(session: ClaudeSession): Promise<void> {
  const settled = session.turnSettled;
  unregisterSessionIfOwned(session);
  const errors: unknown[] = [];
  try {
    if (!session.queue.closed) session.queue.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    if (settled) await awaitCleanupStep(settled, 'the active turn');
  } catch (error) {
    errors.push(error);
  }
  try {
    await awaitCleanupStep(session.query.return(undefined), 'the provider iterator');
  } catch (error) {
    errors.push(error);
  }
  throwCleanupErrors(errors, 'Claude session cleanup failed');
}

async function disposeOwnedClaudeSession(params: {
  subChatId: string;
  session: ClaudeSession;
  awaitProviderCleanup: boolean;
}): Promise<void> {
  if (params.awaitProviderCleanup) {
    await disposeClaudeSessionAndWait(params.session);
  } else if (getSession(params.subChatId) === params.session) {
    endSession(params.subChatId);
  }
}

function canClearPumpApprovals(
  subChatId: string,
  session: ClaudeSession,
  canClearPendingApprovals?: () => boolean,
): boolean {
  const current = getSession(subChatId);
  return (current === undefined || current === session) && (canClearPendingApprovals?.() ?? true);
}

/** Provider cleanup after a wake pump exits without transferring the session to a turn. */
async function disposeClaudeAfterPump(params: {
  subChatId: string;
  session: ClaudeSession;
  io: PumpCleanupIo;
  awaitProviderCleanup: boolean;
  canClearPendingApprovals?: () => boolean;
}): Promise<void> {
  const { subChatId, session, io, awaitProviderCleanup, canClearPendingApprovals } = params;
  const errors: unknown[] = [];
  await captureCleanupError(errors, () =>
    disposeOwnedClaudeSession({ subChatId, session, awaitProviderCleanup }),
  );
  // Provider cleanup can await long enough for a successor session to register under the same key.
  // Re-read after that boundary so stale cleanup never clears the successor's approvals.
  if (canClearPumpApprovals(subChatId, session, canClearPendingApprovals)) {
    await captureCleanupError(errors, () =>
      io.clearPendingApprovals('Background wait ended.', subChatId),
    );
  }
  throwCleanupErrors(errors, 'Wake hold provider cleanup failed');
}

type WakeHoldResources = {
  cancellationPersistence?: Promise<void>;
  releaseFlowResourceActivity?: FlowResourceActivityRelease;
  releaseRuntimeSlot?: () => void;
  unregisterFlowRunAbort?: () => void;
};

type CutShortBurstCleanup = {
  backfill: () => unknown;
  complete: () => unknown;
};

/** Settle the resources owned by one ended wake pump before releasing its Flow activity. */
export async function settleClaudeWakeHold(params: {
  exit: WakePumpExit;
  resources: WakeHoldResources;
  subChatId: string;
  session: ClaudeSession;
  executionContextId: string | undefined;
  io: PumpCleanupIo;
  canClearPendingApprovals?: () => boolean;
  retractIfCurrent: () => unknown;
  dropIfCurrent: () => unknown;
  takeCutShortBurst: () => CutShortBurstCleanup | null;
}): Promise<void> {
  const cleanupErrors: unknown[] = [];
  const preserveThrownFailure = (error: unknown): unknown =>
    error === undefined ? new Error('Wake hold cleanup failed without an error value') : error;
  if (params.exit.reason === 'sink-error') {
    cleanupErrors.push(preserveThrownFailure(params.exit.error));
  }
  const turnOwnedExit =
    params.exit.reason === 'turn-taken-over' || params.exit.reason === 'turn-error';
  const runCleanup = async (operation: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(preserveThrownFailure(error));
    }
  };

  await runCleanup(params.retractIfCurrent);
  log.info(`[Socket Executor] Wake pump for ${params.subChatId} ended: ${params.exit.reason}`);
  const cutShort = params.takeCutShortBurst();
  if (cutShort) {
    await runCleanup(cutShort.backfill);
    await runCleanup(cutShort.complete);
  }

  const drainCancellationPersistence = async (): Promise<void> => {
    const persistenceErrors: unknown[] = [];
    while (params.resources.cancellationPersistence) {
      const persistence = params.resources.cancellationPersistence;
      params.resources.cancellationPersistence = undefined;
      try {
        await persistence;
      } catch (error) {
        // A later Stop can attach while this promise settles. Keep draining before surfacing the
        // earlier failure so every durable cancellation completes before activity release.
        persistenceErrors.push(preserveThrownFailure(error));
      }
    }
    if (persistenceErrors.length > 1) {
      throw new AggregateError(persistenceErrors, 'Wake hold cancellation persistence failed');
    }
    if (persistenceErrors.length === 1) throw persistenceErrors[0];
  };

  await runCleanup(drainCancellationPersistence);
  if (!turnOwnedExit) {
    // Only when THIS cleanup is the one closing stdin: after an explicit release the queue is
    // already closed and that path reported the drop, so reporting again would double-count it.
    if (!params.session.queue.closed) {
      logDroppedPendingWork(
        params.subChatId,
        params.session.stopHook?.lastPendingWork ?? null,
        `wake-pump-exit:${params.exit.reason}`,
      );
    }
    await runCleanup(() =>
      disposeClaudeAfterPump({
        subChatId: params.subChatId,
        session: params.session,
        io: params.io,
        awaitProviderCleanup: Boolean(params.resources.releaseFlowResourceActivity),
        canClearPendingApprovals: params.canClearPendingApprovals,
      }),
    );
  }
  // Every exit, a takeover too: an adopting turn runs under its own context, never the hold's.
  await runCleanup(() => {
    if (params.executionContextId) params.io.clearCurrentExecutionChat(params.executionContextId);
  });
  await runCleanup(() => params.resources.releaseRuntimeSlot?.());
  params.resources.releaseRuntimeSlot = undefined;
  // Stop can arrive while provider or runtime cleanup awaits. This is the final await before
  // removing the discoverable owner and releasing activity, so no late persistence can be lost.
  await runCleanup(drainCancellationPersistence);
  await runCleanup(() => params.resources.unregisterFlowRunAbort?.());
  params.resources.unregisterFlowRunAbort = undefined;
  const releaseActivity = params.resources.releaseFlowResourceActivity;
  params.resources.releaseFlowResourceActivity = undefined;
  await runCleanup(params.dropIfCurrent);

  const cleanupError =
    cleanupErrors.length > 1
      ? new AggregateError(cleanupErrors, 'Wake hold cleanup failed')
      : cleanupErrors[0];
  try {
    releaseActivity?.(cleanupError);
  } catch (error) {
    cleanupErrors.push(error);
  }
  throwCleanupErrors(cleanupErrors, 'Wake hold cleanup failed');
}
