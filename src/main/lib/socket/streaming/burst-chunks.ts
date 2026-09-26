/**
 * Chunk writes a wake burst makes into the turn's merged assistant message.
 *
 * This synthesises chunks the model did not produce, which is why it lives beside the wake pump's
 * other stream seams rather than inside it: the pump stays a state machine, and this stays one
 * small rule about what a burst still owes the transcript.
 */

import fs from 'node:fs';
import log from 'electron-log';
import { resolveLatestSessionPlanFile } from '../../claude/session-plan-paths';
import type { UIMessageChunk } from '../../claude/types';
import type { MessagePart } from '../client';
import { emitInlinePlanCard, matchDeniedToolMessage } from '../claude-turn-context';

/**
 * The SDK sends no tool_result for hook-denied tools; without a synthetic tool-output-error a denied
 * wake-burst tool renders as a permanently spinning input-available card. Mirrors the executor's
 * post-stream backfill (shared matchDeniedToolMessage for the composite-id match).
 *
 * Scanned from `startIndex` because `chunks` spans the whole wait: the arming turn and earlier
 * bursts were backfilled under their own denied maps and must not be re-walked.
 */
export function backfillDeniedTools(
  chunks: UIMessageChunk[],
  startIndex: number,
  deniedToolIdsWithMessages: Map<string, string>,
  emitChunk: (chunk: UIMessageChunk) => void,
): void {
  const outputIds = new Set(
    chunks.flatMap((c) =>
      c.type === 'tool-output-available' || c.type === 'tool-output-error' ? [c.toolCallId] : [],
    ),
  );
  const initialLength = chunks.length;
  for (let i = startIndex; i < initialLength; i++) {
    const chunk = chunks[i];
    if (chunk.type !== 'tool-input-available' || outputIds.has(chunk.toolCallId)) continue;
    const message = matchDeniedToolMessage(deniedToolIdsWithMessages, chunk.toolCallId);
    if (!message) continue;
    emitChunk({
      type: 'tool-output-error',
      toolCallId: chunk.toolCallId,
      errorText: message,
      permissionDenied: true,
    });
  }
}

/**
 * The tool call id of an ExitPlanMode this burst attempted and was denied, else null.
 *
 * A wake burst's plan submission is denied (see `denyPlanTransitionInWakeBurst`), which leaves the
 * attempt recorded in two places that already exist: the burst's denied map, and the burst's own
 * `tool-input-available` chunk. That pair IS the submission signal — nothing needs to be threaded
 * out of the hook. Scanned from `startIndex` for the same reason as {@link backfillDeniedTools}:
 * `chunks` spans the whole wait, and an earlier burst's attempt was already handled under its own
 * denied map.
 */
export function burstPlanSubmissionAttempt(
  chunks: UIMessageChunk[],
  startIndex: number,
  deniedToolIdsWithMessages: Map<string, string>,
): string | null {
  for (let i = startIndex; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.type !== 'tool-input-available' || chunk.toolName !== 'ExitPlanMode') continue;
    if (matchDeniedToolMessage(deniedToolIdsWithMessages, chunk.toolCallId)) return chunk.toolCallId;
  }
  return null;
}

/**
 * Card the plan a wake burst finished, so it can be approved without a further user message.
 *
 * The card body comes from the plan FILE (written by an allowed burst Write before the denied
 * ExitPlanMode), so this needs none of the foreground stream's plan bookkeeping — see decision
 * `flow-quiet-wait-handling`.
 *
 * Emits at most one card per wait, for a plan belonging to that wait:
 * - `planAlreadySubmitted` — the halt denies a re-attempted ExitPlanMode, which lands back here.
 * - `waitStartedMs` — the session plans dir outlives the turn that wrote it, so an attempt that
 *   produced no plan of its own would otherwise resolve a previous turn's.
 * - `planAutoApprove` — no human approver exists, and its Auto grant must be armed in the
 *   foreground (sc-2340).
 *
 * `onSubmitted` raises the halt, so it fires only once a card actually reached the transcript.
 */
export async function emitBurstPlanCard(params: {
  chatId: string;
  subChatId: string;
  msgId: string;
  chunks: UIMessageChunk[];
  startIndex: number;
  deniedToolIdsWithMessages: Map<string, string>;
  flowDriven: boolean;
  planAutoApprove: boolean;
  /** The halt is already up: this wait has submitted its plan and owes no second card. */
  planAlreadySubmitted: boolean;
  /** Epoch ms this wait's arming turn began; a plan older than it belongs to an earlier turn. */
  waitStartedMs: number;
  nextMessageIndex: () => number;
  streamChunk: (msgId: string, chunk: UIMessageChunk, parts: MessagePart[], index: number) => void;
  onSubmitted: () => void;
}): Promise<void> {
  const { chatId, subChatId, msgId, chunks, nextMessageIndex, streamChunk } = params;
  if (params.planAutoApprove || params.planAlreadySubmitted) return;
  if (!burstPlanSubmissionAttempt(chunks, params.startIndex, params.deniedToolIdsWithMessages)) {
    return;
  }
  const planPath = await resolveLatestSessionPlanFile(subChatId);
  if (!planPath || !(await isPlanFromThisWait(planPath, params.waitStartedMs))) {
    log.warn(`[Socket Executor] Wake burst submitted no plan of its own for ${subChatId}`);
    return;
  }
  const emitted = await emitInlinePlanCard({
    chatId,
    subChatId,
    assistantMessageId: msgId,
    planPath,
    collectedChunks: chunks,
    // The burst owns the stream index: emitInlinePlanCard advances a LOCAL counter, and the
    // renderer drops any chunk at or below its per-message high-water mark, so replaying that
    // counter here would silently discard the card. Its return value is ignored for the same reason.
    messageIndex: 0,
    flowDriven: params.flowDriven,
    autoApproved: false,
    send: ({ chunk, parts }) => streamChunk(msgId, chunk, parts, nextMessageIndex()),
  });
  if (emitted !== null) params.onSubmitted();
}

/** Whether `planPath` was written during this wait rather than carried over from an earlier turn.
 * Unreadable stats answer NO: presenting a plan we cannot date is worse than presenting none. */
async function isPlanFromThisWait(planPath: string, waitStartedMs: number): Promise<boolean> {
  try {
    const { mtimeMs } = await fs.promises.stat(planPath);
    return mtimeMs >= waitStartedMs;
  } catch {
    return false;
  }
}
