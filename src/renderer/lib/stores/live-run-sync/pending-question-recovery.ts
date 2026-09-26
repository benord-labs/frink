import { rememberBounded } from '../../utils/bounded-set';

type QuestionChunk = {
  type: string;
  toolUseId?: string;
  toolCallId?: string;
  questions?: unknown[];
  result?: unknown;
};

export type PendingQuestionProjection = {
  chatId: string;
  subChatId: string;
  toolUseId: string;
  questions: unknown[];
};

export type QuestionStreamEvent = {
  chatId?: string;
  subChatId: string;
  chunk?: unknown;
};

export type ApplyQuestionChunk = (input: {
  chunk: QuestionChunk;
  subChatId: string;
  parentChatId: string;
}) => void;

const QUESTION_FENCE_LIMIT = 64;

function questionChunkToolId(chunk: QuestionChunk): string | undefined {
  if (typeof chunk.toolUseId === 'string') return chunk.toolUseId;
  return typeof chunk.toolCallId === 'string' ? chunk.toolCallId : undefined;
}

function questionKey(subChatId: string, toolUseId: string): string {
  return JSON.stringify([subChatId, toolUseId]);
}

function rememberQuestionEvent(knownQuestionKeys: Set<string>, key: string): void {
  rememberBounded(knownQuestionKeys, key, QUESTION_FENCE_LIMIT);
}

export function projectLiveQuestionChunk(
  event: QuestionStreamEvent,
  retiredQuestionIds: Set<string>,
  knownQuestionKeys: Set<string>,
  applyQuestionChunk: ApplyQuestionChunk,
): void {
  if (!event.chunk || typeof event.chunk !== 'object') return;
  const chunk = event.chunk as QuestionChunk;
  const toolUseId = questionChunkToolId(chunk);
  if (toolUseId) {
    const key = questionKey(event.subChatId, toolUseId);
    if (chunk.type === 'ask-user-question') {
      retiredQuestionIds.delete(key);
      rememberQuestionEvent(knownQuestionKeys, key);
    } else if (
      chunk.type === 'ask-user-question-timeout' ||
      chunk.type === 'ask-user-question-result' ||
      ((chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') &&
        knownQuestionKeys.has(key))
    ) {
      rememberBounded(retiredQuestionIds, key, QUESTION_FENCE_LIMIT);
      knownQuestionKeys.delete(key);
    }
  }
  if (typeof event.chatId !== 'string') return;
  applyQuestionChunk({
    chunk,
    subChatId: event.subChatId,
    parentChatId: event.chatId,
  });
}

function isValidPendingQuestion(
  pending: PendingQuestionProjection,
  expectedSubChatId: string,
): boolean {
  return (
    typeof pending.chatId === 'string' &&
    typeof pending.subChatId === 'string' &&
    pending.subChatId === expectedSubChatId &&
    typeof pending.toolUseId === 'string' &&
    Array.isArray(pending.questions)
  );
}

export function restoreSeededPendingQuestions(
  pendingQuestions: PendingQuestionProjection[],
  subChatId: string,
  retiredQuestionIds: ReadonlySet<string>,
  knownQuestionKeys: Set<string>,
  applyQuestionChunk: ApplyQuestionChunk,
): boolean {
  for (const pending of pendingQuestions) {
    if (!isValidPendingQuestion(pending, subChatId)) return false;
    const key = questionKey(pending.subChatId, pending.toolUseId);
    if (retiredQuestionIds.has(key) || knownQuestionKeys.has(key)) continue;
    rememberQuestionEvent(knownQuestionKeys, key);
    applyQuestionChunk({
      chunk: {
        type: 'ask-user-question',
        toolUseId: pending.toolUseId,
        questions: pending.questions,
      },
      subChatId: pending.subChatId,
      parentChatId: pending.chatId,
    });
  }
  return true;
}
