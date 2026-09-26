import { useAtomValue } from 'jotai';
import { memo } from 'react';
import { useMessageRenderDebug } from '../dev/use-message-render-debug';
import {
  isLastMessageForSubChatAtomFamily,
  isStreamingForSubChatAtomFamily,
  messageAtomFamily,
  perSubChatStatusAtomFamily,
} from '../stores/message-store';
import { AssistantMessageItem } from './assistant-message-item';

// ============================================================================
// MESSAGE ITEM - Subscribes to its own message only
// ============================================================================

type MessageItemWrapperProps = {
  messageId: string;
  subChatId: string;
  chatId: string;
  isLastAssistantMessage: boolean;
  isMobile: boolean;
  sandboxSetupStatus: 'cloning' | 'ready' | 'error';
};

// For non-last messages - no streaming subscription needed
// Subscribes to message via Jotai messageAtomFamily, passes message as prop to AssistantMessageItem
const NonStreamingMessageItem = memo(function NonStreamingMessageItem({
  messageId,
  subChatId,
  chatId,
  isLastAssistantMessage,
  isMobile,
  sandboxSetupStatus,
}: {
  messageId: string;
  subChatId: string;
  chatId: string;
  isLastAssistantMessage: boolean;
  isMobile: boolean;
  sandboxSetupStatus: 'cloning' | 'ready' | 'error';
}) {
  // Subscribe to this specific message via Jotai - only re-renders when THIS message changes
  const message = useAtomValue(messageAtomFamily(messageId));
  useMessageRenderDebug('non-streaming', messageId);

  if (!message) return null;

  return (
    <AssistantMessageItem
      message={message}
      isLastMessage={false}
      isStreaming={false}
      status="ready"
      subChatId={subChatId}
      chatId={chatId}
      isLastAssistantMessage={isLastAssistantMessage}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
    />
  );
});

// For the last message - subscribes to streaming status AND message via Jotai
// Passes message as prop to AssistantMessageItem
const StreamingMessageItem = memo(function StreamingMessageItem({
  messageId,
  subChatId,
  chatId,
  isLastAssistantMessage,
  isMobile,
  sandboxSetupStatus,
}: {
  messageId: string;
  subChatId: string;
  chatId: string;
  isLastAssistantMessage: boolean;
  isMobile: boolean;
  sandboxSetupStatus: 'cloning' | 'ready' | 'error';
}) {
  // Subscribe to this specific message via Jotai - only re-renders when THIS message changes
  const message = useAtomValue(messageAtomFamily(messageId));

  // Subscribe to per-subChat streaming status (split view safe)
  const isStreaming = useAtomValue(isStreamingForSubChatAtomFamily(subChatId));
  const status = useAtomValue(perSubChatStatusAtomFamily(subChatId));
  useMessageRenderDebug('streaming', messageId);

  if (!message) return null;

  return (
    <AssistantMessageItem
      message={message}
      isLastMessage={true}
      isStreaming={isStreaming}
      status={status}
      subChatId={subChatId}
      chatId={chatId}
      isLastAssistantMessage={isLastAssistantMessage}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
    />
  );
});

const MessageItemWrapper = memo(function MessageItemWrapper({
  messageId,
  subChatId,
  chatId,
  isLastAssistantMessage,
  isMobile,
  sandboxSetupStatus,
}: MessageItemWrapperProps) {
  // Only subscribe to isLast - NOT to message content!
  // StreamingMessageItem and NonStreamingMessageItem will subscribe to message themselves
  const isLast = useAtomValue(isLastMessageForSubChatAtomFamily(`${subChatId}:${messageId}`));

  // Only the last message subscribes to streaming status
  if (isLast) {
    // StreamingMessageItem subscribes to messageAtomFamily internally
    return (
      <StreamingMessageItem
        messageId={messageId}
        subChatId={subChatId}
        chatId={chatId}
        isLastAssistantMessage={isLastAssistantMessage}
        isMobile={isMobile}
        sandboxSetupStatus={sandboxSetupStatus}
      />
    );
  }

  // NonStreamingMessageItem subscribes to messageAtomFamily internally
  return (
    <NonStreamingMessageItem
      messageId={messageId}
      subChatId={subChatId}
      chatId={chatId}
      isLastAssistantMessage={isLastAssistantMessage}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
    />
  );
});

// ============================================================================
// MEMOIZED ASSISTANT MESSAGES - Only re-renders when message IDs change
// ============================================================================

// This is the KEY optimization component.
// By wrapping the assistant messages .map() in a memoized component that
// compares ONLY the message IDs (not the full message objects), we prevent
// the parent's re-render from causing MessageItemWrapper to be called.

type MemoizedAssistantMessagesProps = {
  assistantMsgIds: string[];
  subChatId: string;
  chatId: string;
  isMobile: boolean;
  sandboxSetupStatus: 'cloning' | 'ready' | 'error';
};

function areMemoizedAssistantMessagesEqual(
  prev: MemoizedAssistantMessagesProps,
  next: MemoizedAssistantMessagesProps,
): boolean {
  // Only re-render if IDs changed (new message added/removed)
  if (prev.assistantMsgIds.length !== next.assistantMsgIds.length) {
    return false;
  }

  // Check if all IDs are the same
  for (let i = 0; i < prev.assistantMsgIds.length; i++) {
    if (prev.assistantMsgIds[i] !== next.assistantMsgIds[i]) {
      return false;
    }
  }

  // Also check static props
  if (prev.subChatId !== next.subChatId) return false;
  if (prev.chatId !== next.chatId) return false;
  if (prev.isMobile !== next.isMobile) return false;
  if (prev.sandboxSetupStatus !== next.sandboxSetupStatus) return false;

  return true;
}

export const MemoizedAssistantMessages = memo(function MemoizedAssistantMessages({
  assistantMsgIds,
  subChatId,
  chatId,
  isMobile,
  sandboxSetupStatus,
}: MemoizedAssistantMessagesProps) {
  // This component only re-renders when assistantMsgIds changes
  // During streaming, IDs stay the same, so this doesn't re-render
  // Therefore, MessageItemWrapper is never called, and the store
  // subscription handles updates directly
  return (
    <>
      {assistantMsgIds.map((id, index) => (
        <MessageItemWrapper
          key={id}
          messageId={id}
          subChatId={subChatId}
          chatId={chatId}
          isLastAssistantMessage={index === assistantMsgIds.length - 1}
          isMobile={isMobile}
          sandboxSetupStatus={sandboxSetupStatus}
        />
      ))}
    </>
  );
}, areMemoizedAssistantMessagesEqual);
