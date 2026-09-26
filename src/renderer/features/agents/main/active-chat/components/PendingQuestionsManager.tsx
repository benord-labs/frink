import { captureException } from '@sentry/electron/renderer';
import { useAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { TERMINAL_TOOL_PART_STATES } from '../../../../../../shared/types/assistant-message';
import { trpcClient } from '../../../../../lib/trpc';
import { pendingUserQuestionsAtom, QUESTIONS_SKIPPED_MESSAGE } from '../../../atoms';
import type { Message, MessagePart } from '../../../stores/message-store';

type Props = {
  subChatId: string;
  isStreaming: boolean;
  lastAssistantMessage: Message | null;
};

export function usePendingQuestionsManager({
  subChatId,
  isStreaming,
  lastAssistantMessage,
}: Props) {
  const [pendingQuestionsMap, setPendingQuestionsMap] = useAtom(pendingUserQuestionsAtom);
  const pendingQuestions =
    [...pendingQuestionsMap.values()].find((pending) => pending.subChatId === subChatId) ?? null;

  // Helper to clear pending question for this subChat
  const clearPendingQuestionCallback = useCallback(() => {
    const toolUseId = pendingQuestions?.toolUseId;
    if (!toolUseId) return;
    setPendingQuestionsMap((current) => {
      if (current.has(toolUseId)) {
        const newMap = new Map(current);
        newMap.delete(toolUseId);
        return newMap;
      }
      return current;
    });
  }, [pendingQuestions?.toolUseId, setPendingQuestionsMap]);

  // Retire when this question's own tool call settled; the stream stopping says nothing by itself.
  useEffect(() => {
    if (!pendingQuestions) return;
    const settledOwnPart = lastAssistantMessage?.parts?.find(
      (part: MessagePart) =>
        part.type === 'tool-AskUserQuestion' &&
        part.toolCallId === pendingQuestions.toolUseId &&
        TERMINAL_TOOL_PART_STATES.has(part.state ?? ''),
    );
    if (settledOwnPart) clearPendingQuestionCallback();
  }, [lastAssistantMessage, pendingQuestions, clearPendingQuestionCallback]);

  // When the stream stops, ask main whether it still holds the question instead of assuming: a
  // wake hold keeps it answerable, while a park whose timeout chunk this pane missed has dropped it.
  useEffect(() => {
    if (isStreaming || !pendingQuestions) return;
    let stale = false;
    trpcClient.socket.listPendingQuestionSubChatIds
      .query()
      .then((held) => {
        if (!stale && !held.includes(subChatId)) clearPendingQuestionCallback();
      })
      .catch((error: Error) =>
        captureException(error, { tags: { surface: 'question-reconcile' } }),
      );
    return () => {
      stale = true;
    };
  }, [isStreaming, pendingQuestions, subChatId, clearPendingQuestionCallback]);

  // Handle answering questions
  const handleQuestionsAnswer = useCallback(
    async (answers: Record<string, string>) => {
      if (!pendingQuestions) return false;
      try {
        const result = await trpcClient.claude.respondToolApproval.mutate({
          toolUseId: pendingQuestions.toolUseId,
          approved: true,
          updatedInput: { questions: pendingQuestions.questions, answers },
        });
        // Parking may have won the backend CAS while this answer was in flight. Keep the native card
        // until the durable park chunk replaces it so a rejected late answer is never hidden.
        if (result.ok) clearPendingQuestionCallback();
        return result.ok;
      } catch (_error) {
        return false;
      }
    },
    [pendingQuestions, clearPendingQuestionCallback],
  );

  // Handle skipping questions
  const handleQuestionsSkip = useCallback(async () => {
    if (!pendingQuestions) return false;
    const toolUseId = pendingQuestions.toolUseId;

    // Parking may already own the backend latch. Keep the question visible until either the denial
    // wins or the durable parked-question chunk replaces it.
    try {
      const result = await trpcClient.claude.respondToolApproval.mutate({
        toolUseId,
        approved: false,
        updatedInput: { error: QUESTIONS_SKIPPED_MESSAGE },
      });
      if (result.ok) clearPendingQuestionCallback();
      return result.ok;
    } catch (_error) {
      // Ignore error - stream might already be aborted
      return false;
    }
  }, [pendingQuestions, clearPendingQuestionCallback]);

  return {
    pendingQuestions,
    handleQuestionsAnswer,
    handleQuestionsSkip,
    clearPendingQuestionCallback,
  };
}
