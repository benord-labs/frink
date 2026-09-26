import type { UIMessage } from 'ai';
import { useEffect } from 'react';

type Props = {
  hasExistingSession: boolean;
  messages: UIMessage[];
  status: string;
  streamId?: string | null;
  hasTriggeredAutoGenerateRef: React.RefObject<boolean>;
  regenerate: () => void;
};

export function AutoGenerateManager({
  hasExistingSession,
  messages,
  status,
  streamId,
  hasTriggeredAutoGenerateRef,
  regenerate,
}: Props) {
  // Auto-trigger AI response when we have initial message but no response yet.
  // Skip if sub-chat already has a persisted session (was already executed -- e.g. after chat move).
  // Skip when there is no user message (e.g. flow chat_reply notification — nothing to respond to).
  useEffect(() => {
    const hasNoUserMessages = messages.length > 0 && messages.every((m) => m.role !== 'user');
    const shouldAutoGenerate =
      messages.length === 1 &&
      status === 'ready' &&
      !streamId &&
      !hasExistingSession &&
      !hasNoUserMessages &&
      !hasTriggeredAutoGenerateRef.current;
    if (shouldAutoGenerate) {
      hasTriggeredAutoGenerateRef.current = true;
      regenerate();
    }
  }, [status, messages, regenerate, hasExistingSession, streamId, hasTriggeredAutoGenerateRef]);

  return null;
}
