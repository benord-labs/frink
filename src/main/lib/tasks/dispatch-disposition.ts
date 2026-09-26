/**
 * Disposition policy for task-dispatch failures (the catch in handleClaimedTask).
 *
 * A dispatch failure has no chat to resume into, so it can only retry or fail:
 * - Errors stamped `permanent: true` (deleted worktree, unauthenticated project account)
 *   are deterministic — retrying cannot fix them, so the task fails immediately and the
 *   flow watcher surfaces the failed node/run.
 * - Everything else retries on the poller cadence up to MAX_DISPATCH_ATTEMPTS, tracked in
 *   `result.dispatchAttempts`. The counter survives re-claims (claimTask never touches
 *   `result`) and is wiped by the wholesale result write of a successful dispatch.
 */

import log from 'electron-log';
import type { getDatabase } from '../db';
import { parseResultRecord, updateTaskStatus } from '../db/repos/tasks';
import { captureMainMessage } from '../sentry/init';

export const MAX_DISPATCH_ATTEMPTS = 20;

/** Metadata throw sites stamp onto dispatch errors; the disposition carries it into `result`. */
export type DispatchErrorMeta = {
  permanent?: boolean;
  action?: string;
  dispatchErrorCode?: string;
  dispatchErrorRemediation?: string;
};

type DispatchError = Error & DispatchErrorMeta;

export type DispatchFailureDisposition = {
  status: 'failed' | 'pending';
  permanent: boolean;
  dispatchAttempts: number;
  result: Record<string, unknown>;
};

/**
 * Maps a dispatch error + the task's prior `result` to the status/result to persist.
 * Merges into the prior result (never replaces): wiping it would drop `chatId`/`subChatId`
 * and orphan a new chat on every retry of a continue-mode task.
 */
/**
 * Classifies and persists a dispatch failure for a claimed task. The status write is CAS-guarded
 * on `running`: a concurrent Cancel/Stop that already terminalized the task must win — an
 * unconditional write would resurrect a cancelled task back to `pending`. Never throws.
 */
export async function persistDispatchFailure(
  db: ReturnType<typeof getDatabase>,
  task: { id: string; result: unknown },
  error: unknown,
): Promise<void> {
  const disposition = classifyDispatchFailure(error, parseResultRecord(task.result));
  if (disposition.status === 'failed') {
    // Terminal dispatch failures are user-visible dead ends — monitor the class.
    captureMainMessage('task dispatch failed terminally', 'warning', {
      permanent: String(disposition.permanent),
      dispatchAttempts: String(disposition.dispatchAttempts),
    });
  }
  log.warn('[TaskExecutor] task dispatch failed', {
    taskId: task.id,
    status: disposition.status,
    permanent: disposition.permanent,
    dispatchAttempts: disposition.dispatchAttempts,
    error: disposition.result.error,
  });
  try {
    const updated = await updateTaskStatus(db, task.id, disposition.status, {
      result: disposition.result,
      expectStatuses: ['running'],
    });
    if (!updated) {
      log.warn('[TaskExecutor] dispatch-failure write skipped — task no longer running', {
        taskId: task.id,
      });
    }
  } catch (statusUpdateError) {
    // Keep non-throw behavior, but do not silently hide queue-state drift.
    log.error('[TaskExecutor] Failed to update task status after chat setup failure', {
      taskId: task.id,
      error: statusUpdateError instanceof Error ? statusUpdateError.message : statusUpdateError,
    });
  }
}

export function classifyDispatchFailure(
  error: unknown,
  priorResult: Record<string, unknown>,
): DispatchFailureDisposition {
  const err = error instanceof Error ? (error as DispatchError) : null;
  const message = err?.message ?? 'Task execution failed';
  const permanent = err?.permanent === true;
  const errorAction = typeof err?.action === 'string' ? err.action : undefined;
  const priorAttempts =
    typeof priorResult.dispatchAttempts === 'number' ? priorResult.dispatchAttempts : 0;
  const dispatchAttempts = priorAttempts + 1;
  const terminal = permanent || dispatchAttempts >= MAX_DISPATCH_ATTEMPTS;

  return {
    status: terminal ? 'failed' : 'pending',
    permanent,
    dispatchAttempts,
    result: {
      ...priorResult,
      error: message,
      dispatchAttempts,
      ...(errorAction ? { errorAction } : {}),
      ...(err?.dispatchErrorCode ? { dispatchErrorCode: err.dispatchErrorCode } : {}),
      ...(err?.dispatchErrorRemediation
        ? { dispatchErrorRemediation: err.dispatchErrorRemediation }
        : {}),
    },
  };
}
