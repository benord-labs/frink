/**
 * Flow-task parking — the resumable-interruption lifecycle (decision flow-run-chat-surface).
 * A park flips the running driving task → `needs_attention` so the task-completion-watcher
 * pauses the flow (node → `awaiting_input`) while a follow-up message / Retry / Resume can
 * revive it; `failed`/`cancelled` would terminalize the run instead. A batch member parks
 * exactly like any other flow task — its stage settles on the BSR, not on run status.
 */
import { and, desc, sql as drizzleSql, eq } from 'drizzle-orm';
import log from 'electron-log';
import { getDatabase } from '../..';
import { tasks } from '../../schema';
import { parseResultRecord } from '../tasks';

type Db = ReturnType<typeof getDatabase>;

/**
 * Failure metadata cleared when a task parks on a resumable interruption — a park is not an
 * error, and a park ends any retry in flight (stale retry markers must not seed the next
 * attempt's continuation nudge).
 */
const PARK_STALE_RESULT_KEYS = [
  'error',
  'failureCode',
  'staleExecution',
  'staleDetectedAt',
  'retryMode',
  'retryRequestedAt',
  'retryPriorError',
  // A new park supersedes any prior park reason — clear ALL reason keys before setting the
  // current one, or a usage-limit→api-error (or user-pause) transition would leave a stale
  // reason on the row.
  'usageLimit',
  'apiError',
  'userPause',
  // A park ends the turn, and with it any hold the turn had open.
  'heldQuestions',
] as const;

/**
 * Resumable interruption reasons a flow task can park on. `user-pause` is the chat Pause button:
 * unlike the transient kinds it is NOT retryable-parked (isRetryableParkedResult stays false), so
 * the paused chat shows the resume surface, not Continue / Retry. An `api-error` with `status: null`
 * is an UNCLASSIFIED stream error (crash, exit-code, unanchored text) parked by the executor's
 * fallback — resumable like the classified kinds, distinguishable for telemetry.
 */
export type ParkReason =
  | { kind: 'usage-limit'; limitText: string }
  | { kind: 'api-error'; status: number | null; message: string }
  | { kind: 'user-pause' };

/**
 * Park the running flow task driving a sub-chat as `needs_attention` on a resumable Claude
 * interruption (usage limit, transient/auth API error) or a user pause. The result is MERGED,
 * not replaced — `result.subChatId`/`startMode` are the linkage that signal routing and resume
 * depend on. Flow-scoped on purpose: parking a work-queue task would fire post-task triggers as
 * if the agent finished. Returns the parked id, or null when nothing was parked.
 */
export async function parkFlowTaskForSubChat(
  db: Db,
  subChatId: string,
  reason: ParkReason,
): Promise<string | null> {
  if (!subChatId) return null;
  const rows = await db
    .select({ id: tasks.id, result: tasks.result })
    .from(tasks)
    .where(
      and(
        eq(tasks.source, 'flow'),
        eq(tasks.status, 'running'),
        drizzleSql`json_extract(${tasks.result}, '$.subChatId') = ${subChatId}`,
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const merged: Record<string, unknown> = parseResultRecord(row.result);
  const at = new Date().toISOString();
  // Scrub stale failure + prior-park markers FIRST, then set the current reason (the scrub list
  // includes the reason keys, so set-after-scrub is what keeps the new one).
  for (const key of PARK_STALE_RESULT_KEYS) {
    delete merged[key];
  }
  if (reason.kind === 'usage-limit') {
    merged.usageLimit = { message: reason.limitText, at };
  } else if (reason.kind === 'api-error') {
    merged.apiError = { message: reason.message, status: reason.status, at };
  } else {
    merged.userPause = { at };
    // The user interrupted the turn: a signal the agent recorded mid-stream is void (a stale
    // `done` would advance the flow past the paused step; a stale question would re-surface).
    // The agent re-signals after Resume. Transient parks keep the signal — their turn resumes it.
    delete merged.agentSignal;
  }

  const updated = await db
    .update(tasks)
    .set({ status: 'needs_attention', completedAt: new Date(), result: merged })
    .where(and(eq(tasks.id, row.id), eq(tasks.status, 'running')))
    .returning({ id: tasks.id });
  return updated[0]?.id ?? null;
}

/**
 * Executor-facing wrapper: park the flow task driving a sub-chat when its stream hits a Claude
 * interruption (usage limit / API error). AWAITED by callers (single local UPDATE) so the park
 * commits before any IPC reaches the renderer — otherwise the renderer's completion/error refetch
 * could still read `running` and mis-fail the task. Swallows errors: a failed park degrades to a
 * stuck status, never blocks the stream teardown.
 */
export async function parkFlowTaskOnClaudeInterruption(
  subChatId: string,
  reason: ParkReason,
): Promise<void> {
  try {
    const taskId = await parkFlowTaskForSubChat(getDatabase(), subChatId, reason);
    if (taskId) {
      // status:null = the executor's unclassified fallback (crash, exit-code, unanchored text) —
      // warn-level so repeating internal errors are visible in logs, unlike a classified blip.
      const unclassified = reason.kind === 'api-error' && reason.status === null;
      log[unclassified ? 'warn' : 'info'](
        `[task-parking] parked flow task ${taskId} as needs_attention (${reason.kind}${unclassified ? ', unclassified' : ''}) for sub-chat ${subChatId}`,
      );
    }
  } catch (err) {
    log.warn(`[task-parking] ${reason.kind} park failed for ${subChatId}:`, err);
  }
}
