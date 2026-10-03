import type { UIMessage } from 'ai';
import { useEffect } from 'react';

type Props = {
  hasExistingSession: boolean;
  /** Resolved, authenticated execution account; every other send path gates on the same flag. */
  isAccountReady: boolean;
  messages: UIMessage[];
  status: string;
  streamId?: string | null;
  hasTriggeredAutoGenerateRef: React.RefObject<boolean>;
  regenerate: () => void;
};

export function AutoGenerateManager({
  hasExistingSession,
  isAccountReady,
  messages,
  status,
  streamId,
  hasTriggeredAutoGenerateRef,
  regenerate,
}: Props) {
  // Replays a new chat's first message once per mount; a failed dispatch is recovered by the Retry
  // control (re-firing would abort a live turn) or by replay on the next mount (sc-2512).
  useEffect(() => {
    const hasNoUserMessages = messages.length > 0 && messages.every((m) => m.role !== 'user');
    const shouldAutoGenerate =
      messages.length === 1 &&
      status === 'ready' &&
      isAccountReady &&
      !streamId &&
      !hasExistingSession &&
      !hasNoUserMessages &&
      !hasTriggeredAutoGenerateRef.current;
    if (shouldAutoGenerate) {
      hasTriggeredAutoGenerateRef.current = true;
      regenerate();
    }
  }, [
    status,
    messages,
    regenerate,
    hasExistingSession,
    isAccountReady,
    streamId,
    hasTriggeredAutoGenerateRef,
  ]);

  return null;
}
