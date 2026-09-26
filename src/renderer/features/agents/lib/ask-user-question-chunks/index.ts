/**
 * AskUserQuestion chunk → atom lifecycle, shared by the two lanes that consume a chat's stream.
 *
 * The transport owns the stream for a turn this window started; the observer lane
 * (`useRealtimeSync`) owns it for a run no transport owns — a between-turn wake burst. Both must
 * raise the question card, or an agent that wakes on background work and asks something renders no
 * prompt and stalls until its ten-minute timeout.
 */

import { appStore } from '../../../../lib/jotai-store';
import {
  askUserQuestionResultsAtom,
  expiredUserQuestionsAtom,
  pendingUserQuestionsAtom,
} from '../../atoms';

type QuestionChunk = {
  type: string;
  toolUseId?: string;
  toolCallId?: string;
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  result?: string | { answers: unknown };
};

function clearPending(toolUseId: string): void {
  const pending = appStore.get(pendingUserQuestionsAtom);
  if (!pending.has(toolUseId)) return;
  const next = new Map(pending);
  next.delete(toolUseId);
  appStore.set(pendingUserQuestionsAtom, next);
}

/** Retire the card iff the chunk names the pending question's own tool call. */
function retireIfOwn(subChatId: string, chunkToolId: string | undefined): void {
  if (!chunkToolId) return;
  const pending = appStore.get(pendingUserQuestionsAtom).get(chunkToolId);
  if (pending?.subChatId === subChatId) clearPending(chunkToolId);
}

function raiseLiveQuestion(chunk: QuestionChunk, subChatId: string, parentChatId: string): void {
  if (!chunk.toolUseId || !chunk.questions) return;
  const next = new Map(appStore.get(pendingUserQuestionsAtom));
  next.set(chunk.toolUseId, {
    subChatId,
    parentChatId,
    toolUseId: chunk.toolUseId,
    questions: chunk.questions,
  });
  appStore.set(pendingUserQuestionsAtom, next);

  // A retry of this exact question replaces its own expired surface, never a parallel question.
  const expired = appStore.get(expiredUserQuestionsAtom);
  if (!expired.has(chunk.toolUseId)) return;
  const nextExpired = new Map(expired);
  nextExpired.delete(chunk.toolUseId);
  appStore.set(expiredUserQuestionsAtom, nextExpired);
}

function expirePendingQuestion(chunk: QuestionChunk, subChatId: string): void {
  if (!chunk.toolUseId) return;
  const pending = appStore.get(pendingUserQuestionsAtom).get(chunk.toolUseId);
  if (pending?.subChatId !== subChatId) return;
  clearPending(chunk.toolUseId);
  // Keep it visible as expired so the user can still answer via a normal message.
  const nextExpired = new Map(appStore.get(expiredUserQuestionsAtom));
  nextExpired.set(chunk.toolUseId, pending);
  appStore.set(expiredUserQuestionsAtom, nextExpired);
}

function recordResultAndRetire(chunk: QuestionChunk, subChatId: string): void {
  if (!chunk.toolUseId) return;
  const next = new Map(appStore.get(askUserQuestionResultsAtom));
  next.set(chunk.toolUseId, chunk.result);
  appStore.set(askUserQuestionResultsAtom, next);
  // The result chunk is emitted only when the approval resolved without an answer (deny, skip,
  // teardown) and is the one signal every such path produces — an aborted subprocess never yields
  // the tool_result that would otherwise retire the card via the tool-output branch.
  retireIfOwn(subChatId, chunk.toolUseId);
}

/**
 * Apply one stream chunk to the AskUserQuestion atoms. Safe to call for every chunk — a card is
 * retired only by a chunk carrying its own toolUseId, never by ambient stream traffic (a
 * concurrent background subagent's tool outputs, text, finish); main owes a terminal chunk
 * carrying that toolUseId on every path.
 */
export function applyAskUserQuestionChunk(params: {
  chunk: QuestionChunk;
  subChatId: string;
  parentChatId: string;
}): void {
  const { chunk, subChatId, parentChatId } = params;
  switch (chunk.type) {
    case 'ask-user-question':
      raiseLiveQuestion(chunk, subChatId, parentChatId);
      break;
    case 'ask-user-question-timeout':
      expirePendingQuestion(chunk, subChatId);
      break;
    case 'ask-user-question-result':
      recordResultAndRetire(chunk, subChatId);
      break;
    case 'tool-output-available':
    case 'tool-output-error':
      // The question's own tool call resolving is the identity-keyed retire.
      retireIfOwn(subChatId, chunk.toolCallId);
      break;
    default:
      break;
  }
}
