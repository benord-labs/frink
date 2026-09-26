/**
 * Stream-error disposition for the flow task driving a sub-chat (the executor's outer catch).
 *
 * Every non-deliberate stream error parks the task `needs_attention` BEFORE any IPC emit, so the
 * renderer's error-path refetch reads the parked status instead of failing the task. Without an
 * unconditional disposition the task stays `running` and the terminal-only completion watcher
 * never advances the run (wedged until the boot sweep). Classified errors keep their HTTP status;
 * unclassified ones park with `status: null`. Batch members are failed terminally by the park
 * repo fn instead, keeping the stage settleable.
 *
 * Deliberate stops (user Stop, chat delete, renderer teardown) stamp executionAbortSources before
 * aborting and are reconciled by their own teardown paths — the park-skip check is NARROWER than
 * the toast-suppression one: only a stamped stop or an explicit "aborted by user" message skips
 * the park. Ambiguous abort text (bare AbortError, "operation was aborted") can come from the
 * SDK/network and must still park.
 *
 * The two checks come apart for an INVOLUNTARY teardown (window reload/crash): it skips the park
 * like any deliberate stop, but still reports, because the user did not ask for it. That split is
 * why the caller passes the abort REASON rather than a boolean — the SDK's error text says
 * "aborted by user" for every abort alike and cannot tell the two apart. Any reason outside
 * INVOLUNTARY_ABORT_REASONS (including the bare 'aborted' a caller passes for an abort that fired
 * with nothing stamped) therefore keeps the silent user-stop handling, exactly as before.
 */
import log from 'electron-log';
import {
  type InvoluntaryAbortReason,
  involuntaryAbortMessage,
  isInvoluntaryAbortReason,
  isUserAbortErrorMessage,
} from '../../../shared/lib/user-abort-error';
import {
  classifyApiErrorText,
  extractTrailingApiError,
  extractTrailingUsageLimitText,
  type FinalPartLike,
  isUsageLimitText,
} from '../claude/stream-classifiers';
import type { ApiErrorClassification } from '../claude/stream-classifiers/api-error';
import type { UIMessageChunk } from '../claude/types';
import { parkFlowTaskOnClaudeInterruption } from '../db/repos';
import { captureMainMessage } from '../sentry/init';
import { getActiveExecution } from '../socket/streaming/execution-registry';

const SAFE_USAGE_LIMIT_MESSAGE = 'Claude usage limit reached. Please try again later.';

/**
 * Latch the abort reason for ONE execution, read at the instant ITS signal fires.
 *
 * The executor's `executionAbortSources` is keyed by sub-chat, not by run: every abort path stamps
 * it and the aborted run's own teardown clears it, so a read taken LATER — in a catch, after an
 * await — can land on an entry a different run left behind and mis-file this run's genuine failure
 * as a teardown (skipping its park, and durably stamping `interruptedBy` on the wrong message).
 * Reading on the `abort` event closes that window: every caller stamps before calling `.abort()`,
 * so the value latched here is the one recorded for THIS signal, and a later stamp cannot reach it.
 *
 * `'aborted'` for a signal that fired with nothing stamped preserves the older boolean behaviour —
 * still a stop, and deliberately not an involuntary reason.
 */
export function latchAbortReason(
  signal: AbortSignal,
  sources: ReadonlyMap<string, string>,
  key: string,
  prior?: () => string | undefined,
): () => string | undefined {
  let latched: string | undefined;
  signal.addEventListener('abort', () => {
    latched = sources.get(key) ?? 'aborted';
  });
  // `prior` wins: a run that REPLACES its controller mid-flight must still see a reason latched
  // before the swap, and aborts after it land on the new signal.
  // Without chaining, an abort delivered to whichever controller is not watched reads as no abort
  // at all, and the teardown reporting silently does nothing for that run.
  return () => prior?.() ?? latched;
}

/** Category stamped on a thrown error by its throw site (e.g. FLOW_RUN_ENDED from preflight). */
export function stampedErrorCategory(error: unknown): string | undefined {
  const category = error instanceof Error ? (error as { category?: unknown }).category : undefined;
  return typeof category === 'string' ? category : undefined;
}

/**
 * Category field for the outgoing execute:error payload (spreadable; empty when unclassified).
 * An explicit stamp on the thrown error (e.g. FLOW_RUN_ENDED from provider preflight) outranks
 * the text heuristics — the stamping site knows exactly what failed, the heuristics only guess.
 */
export function resolveErrorPayloadCategory(
  stampedCategory: string | undefined,
  isUsageLimit: boolean,
  terminalApiError: ApiErrorClassification | null,
): { category: string } | Record<string, never> {
  const category =
    stampedCategory ?? (isUsageLimit ? 'RATE_LIMIT_SDK' : terminalApiError ? 'API_ERROR' : null);
  return category ? { category } : {};
}

export type FlowStreamErrorDispositionOptions = {
  /** Category stamped on the thrown error itself (e.g. FLOW_RUN_ENDED) — already classified. */
  stampedCategory?: string;
  /** The failing run's CURRENT controller — used to detect a superseding execution. */
  executionController?: AbortController | null;
  /** Controlled message for durable and renderer-facing sinks. The raw error remains transient. */
  safeErrorMessage?: string;
};

/**
 * Swallows park failures — a failed park degrades to a stuck status but must never break the
 * stream teardown (renderer error emit + cleanup still run). `parkApiError` is a PREDICATE
 * evaluated immediately before the write: a superseding send can land between the disposition's
 * entry and this park, and a stale go-ahead would flip the superseder's live task row.
 */
async function parkFailedStream(
  subChatId: string,
  errorMessage: string,
  opts: { isUsageLimit: boolean; parkApiError: () => boolean; status: number | null },
): Promise<void> {
  try {
    if (opts.isUsageLimit) {
      await parkFlowTaskOnClaudeInterruption(subChatId, {
        kind: 'usage-limit',
        limitText: errorMessage,
      });
    } else if (opts.parkApiError()) {
      await parkFlowTaskOnClaudeInterruption(subChatId, {
        kind: 'api-error',
        status: opts.status,
        message: errorMessage.slice(0, 4096),
      });
    }
  } catch (err) {
    log.warn(`[stream-error-disposition] park failed for ${subChatId}:`, err);
  }
}

export async function disposeFlowStreamError(
  subChatId: string,
  errorMessage: string,
  abortReason: string | undefined,
  options: FlowStreamErrorDispositionOptions = {},
): Promise<{
  isUsageLimit: boolean;
  terminalApiError: ApiErrorClassification | null;
  isUserStoppedExecution: boolean;
  /** Non-null when Frink tore the turn down: what to persist, and what to say. */
  involuntary: InvoluntaryAbortReason | null;
  /** What to report — the SDK's own wording where it is honest, ours where it is not. */
  reportMessage: string;
  /**
   * True when this is a flow-run decline (FLOW_RUN_ENDED / FLOW_RUN_RESUMING) for a send a NEWER execution superseded (the
   * registry entry is another run's — or already cleaned up by the superseder's own teardown).
   * The caller must then NOT emit the error to the renderer: the new turn's listener set has no
   * assistantMessageId yet to drop it as stale, so it would tear the recovery stream down. The
   * park is skipped for the same reason — it is keyed by sub-chat and would park the newer task.
   * When NOT superseded, a stamped decline still parks: a follow-up message can CAS-flip a failed
   * task back to `running` before the eligibility assert throws, and the park is the only writer
   * that un-sticks that row.
   *
   * A FUNCTION, not a snapshot: a superseding send can register during this disposition's park
   * await, so the emit decision must re-read the registry at its own moment.
   */
  supersededDecline: () => boolean;
}> {
  const { executionController, safeErrorMessage, stampedCategory } = options;
  const involuntary = isInvoluntaryAbortReason(abortReason) ? abortReason : null;
  const isDeliberateStop =
    abortReason !== undefined || errorMessage.toLowerCase().includes('aborted by user');
  // A window reload or crash is a deliberate stop for PARKING (its own teardown already reconciled
  // the flow task, so parking here would fight it) but never a USER stop: the user-stop path is
  // silent by design, and staying silent about a run Frink itself killed leaves the turn frozen
  // mid-tool-call with nothing saying why.
  const isUserStoppedExecution =
    !involuntary && (isDeliberateStop || isUserAbortErrorMessage(errorMessage));
  const isUsageLimit = !isUserStoppedExecution && isUsageLimitText(errorMessage);
  const terminalApiError =
    !isUserStoppedExecution && !isUsageLimit ? classifyApiErrorText(errorMessage) : null;
  const reportingMessage =
    safeErrorMessage == null
      ? errorMessage
      : isUsageLimit
        ? SAFE_USAGE_LIMIT_MESSAGE
        : safeErrorMessage;
  const supersededDecline = (): boolean =>
    (stampedCategory === 'FLOW_RUN_ENDED' || stampedCategory === 'FLOW_RUN_RESUMING') &&
    executionController != null &&
    getActiveExecution(subChatId)?.controller !== executionController;
  await parkFailedStream(subChatId, reportingMessage, {
    isUsageLimit,
    parkApiError: () => !isDeliberateStop && !supersededDecline(),
    status: terminalApiError?.status ?? null,
  });
  if (!isUsageLimit && !isDeliberateStop && !terminalApiError && !stampedCategory) {
    // Unclassified stream error (crash, exit-code, unanchored text): parked as resumable, but a
    // repeating internal error must not hide behind the park — monitor the class.
    captureMainMessage('flow stream error parked unclassified', 'warning', { subChatId });
  }
  if (involuntary) {
    // Frink killed a run the user never stopped. The chat now says so, but the user cannot tell
    // whether it is rare or constant — a rising rate here is a regression in the app's own window
    // lifecycle, and it destroys unfinished agent work every time it fires.
    captureMainMessage('agent run torn down involuntarily', 'warning', {
      subChatId,
      reason: involuntary,
    });
  }
  return {
    isUsageLimit,
    terminalApiError,
    isUserStoppedExecution,
    involuntary,
    // Never echo the SDK's wording for an involuntary teardown: it says "aborted by user" for every
    // abort alike, and the renderer discards USER_ABORT_ERROR_PATTERNS matches before it reads the
    // category — so the native message would be dropped on the very path this exists to report.
    reportMessage: involuntary ? involuntaryAbortMessage(involuntary) : reportingMessage,
    supersededDecline,
  };
}

/**
 * Clean-stream sibling of {@link disposeFlowStreamError}: the CLI can end a turn NORMALLY with a
 * usage limit or an API error as the final assistant text — no throw, no task signal — which
 * strands a flow task `running` until the quiet-idle sweep's ceiling. Callers must await this
 * BEFORE emitting completion so the renderer's refetch reads the parked status.
 *
 * A usage limit wins when both would match: it carries a reset time and its own resume affordance.
 */
export async function disposeCleanStreamEnd(
  subChatId: string,
  finalParts: ReadonlyArray<FinalPartLike>,
): Promise<void> {
  const limitText = extractTrailingUsageLimitText(finalParts);
  if (limitText) {
    await parkFlowTaskOnClaudeInterruption(subChatId, { kind: 'usage-limit', limitText });
    return;
  }
  const apiError = extractTrailingApiError(finalParts);
  if (apiError) {
    await parkFlowTaskOnClaudeInterruption(subChatId, {
      kind: 'api-error',
      status: apiError.status,
      message: apiError.message,
    });
  }
}

/** Chunks a provider emits to close a stream — an `error` behind these still ended the turn. */
const STREAM_CLOSING_CHUNK_TYPES = new Set(['finish', 'finish-step', 'text-end']);

/**
 * Chunk-stream twin of {@link disposeFlowStreamError}. Codex never throws for CLI or API
 * failures — it yields `{type:'error', errorText}` and then `finish`, so the turn ends through
 * execute:COMPLETE, the executor's catch never runs, and the flow task sits `running` until the
 * quiet-idle sweep's 45-minute ceiling.
 *
 * Only a TRAILING error disposes: a turn that errored, recovered and kept working is not a terminal
 * failure. The abort gate matters as much — a user pressing Stop SIGKILLs the CLI, which surfaces as
 * a non-zero-exit error chunk that must not park.
 */
export async function disposeTrailingStreamErrorChunk(
  subChatId: string,
  chunks: ReadonlyArray<UIMessageChunk>,
  abortReason: string | undefined,
): Promise<void> {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (STREAM_CLOSING_CHUNK_TYPES.has(chunk.type)) continue;
    if (chunk.type !== 'error') return;
    const errorText = (chunk as { errorText?: unknown }).errorText;
    if (typeof errorText !== 'string' || errorText.length === 0) return;
    await disposeFlowStreamError(subChatId, errorText, abortReason);
    return;
  }
}
