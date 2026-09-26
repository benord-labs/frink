/* eslint-disable max-lines, max-lines-per-function */
import { useAtom, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import {
  isCreatingPrAtomFamily,
  pendingConflictResolutionMessageAtomFamily,
  pendingMoveChatContinuationAtom,
  pendingPrMessageAtomFamily,
  pendingReviewMessageAtomFamily,
} from '../../../atoms';

/**
 * Message part types that can be sent via sendMessage
 */
type SendMessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'data-image';
      data: { base64Data?: string; mediaType?: string; filename?: string };
    };

/**
 * Message format accepted by sendMessage from useChat
 */
type SendMessageInput = {
  role: 'user' | 'assistant' | 'system';
  parts: SendMessagePart[];
};

type ExistingMessage = {
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
};

/**
 * Props for pending message handlers
 */
type Props = {
  subChatId: string;
  parentChatId: string;
  isActive: boolean;
  isStreaming: boolean;
  sendMessage: (message: SendMessageInput) => void;
  messages: ExistingMessage[];
  /** After getResolvedAccount succeeded for parent chat — avoids sends with stale execution account type. */
  isResolvedExecutionAccountReady: boolean;
};

/**
 * Handles pending messages that need to be sent after certain events
 * (PR creation, conflict resolution, auth retry, review, task prompts)
 */
export const usePendingMessageHandlers = ({
  subChatId,
  parentChatId,
  isActive,
  isStreaming,
  sendMessage,
  messages,
  isResolvedExecutionAccountReady,
}: Props) => {
  const [pendingPrMessage, setPendingPrMessage] = useAtom(pendingPrMessageAtomFamily(parentChatId));
  const [pendingReviewMessage, setPendingReviewMessage] = useAtom(
    pendingReviewMessageAtomFamily(parentChatId),
  );
  const [pendingConflictMessage, setPendingConflictMessage] = useAtom(
    pendingConflictResolutionMessageAtomFamily(parentChatId),
  );
  const [pendingMoveChatContinuation, setPendingMoveChatContinuation] = useAtom(
    pendingMoveChatContinuationAtom,
  );
  const setIsCreatingPr = useSetAtom(isCreatingPrAtomFamily(parentChatId));

  // Only the active tab should consume global pending messages.
  // Otherwise an inactive ChatViewInner can steal the send trigger.
  // Watch for pending PR message and send it
  useEffect(() => {
    if (
      pendingPrMessage &&
      !isStreaming &&
      isActive &&
      isResolvedExecutionAccountReady &&
      messages.length > 0
    ) {
      // Clear the pending message immediately to prevent double-sending
      setPendingPrMessage(null);

      // Send the message to Claude
      sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: pendingPrMessage }],
      });

      // Reset creating PR state after message is sent
      setIsCreatingPr(false);
    }
  }, [
    pendingPrMessage,
    isStreaming,
    isActive,
    isResolvedExecutionAccountReady,
    messages,
    sendMessage,
    setPendingPrMessage,
    setIsCreatingPr,
  ]);

  // Watch for pending Review message and send it
  useEffect(() => {
    if (
      pendingReviewMessage &&
      !isStreaming &&
      isActive &&
      isResolvedExecutionAccountReady &&
      messages.length > 0
    ) {
      // Clear the pending message immediately to prevent double-sending
      setPendingReviewMessage(null);

      // Send the message to Claude
      sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: pendingReviewMessage }],
      });
    }
  }, [
    pendingReviewMessage,
    isStreaming,
    isActive,
    isResolvedExecutionAccountReady,
    messages,
    sendMessage,
    setPendingReviewMessage,
  ]);

  // Watch for pending conflict resolution message and send it
  useEffect(() => {
    if (
      pendingConflictMessage &&
      !isStreaming &&
      isActive &&
      isResolvedExecutionAccountReady &&
      messages.length > 0
    ) {
      // Clear the pending message immediately to prevent double-sending
      setPendingConflictMessage(null);

      // Send the message to Claude
      sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: pendingConflictMessage }],
      });
    }
  }, [
    pendingConflictMessage,
    isStreaming,
    isActive,
    isResolvedExecutionAccountReady,
    messages,
    sendMessage,
    setPendingConflictMessage,
  ]);

  // The initial task prompt is delivered headlessly via the global message queue
  // (use-task-ipc-handler → QueueProcessor), so it no longer needs an isActive-gated
  // auto-send here. Only user-action follow-ups (PR/review/conflict/move) remain.

  useEffect(() => {
    if (
      pendingMoveChatContinuation &&
      pendingMoveChatContinuation.chatId === parentChatId &&
      pendingMoveChatContinuation.subChatId === subChatId &&
      !isStreaming &&
      isActive &&
      isResolvedExecutionAccountReady
    ) {
      const { projectName, projectPath } = pendingMoveChatContinuation;
      setPendingMoveChatContinuation(null);

      sendMessage({
        role: 'system',
        parts: [
          {
            type: 'text',
            text: `Continue working. You have been moved to project "${projectName}". Your working directory is now ${projectPath}.`,
          },
        ],
      });
    }
  }, [
    pendingMoveChatContinuation,
    parentChatId,
    subChatId,
    isStreaming,
    isActive,
    isResolvedExecutionAccountReady,
    sendMessage,
    setPendingMoveChatContinuation,
  ]);
};
