import type { PendingChatRetry } from '../../../atoms';

type RetryLastResponse = () => Promise<unknown>;

type SetPending = (value: PendingChatRetry | null) => void;
type SetInFlight = (value: boolean) => void;

type RetryChatParams = {
  isStreaming: boolean;
  retryInFlight: boolean;
  pendingChatRetry: PendingChatRetry | null;
  retryLastResponse: RetryLastResponse;
  dropTrailingAssistantMessage: () => void;
  setPendingChatRetry: SetPending;
  setRetryInFlight: SetInFlight;
};

export async function retryChatMessage(params: RetryChatParams): Promise<void> {
  const {
    isStreaming,
    retryInFlight,
    pendingChatRetry,
    retryLastResponse,
    dropTrailingAssistantMessage,
    setPendingChatRetry,
    setRetryInFlight,
  } = params;

  if (isStreaming || retryInFlight || !pendingChatRetry) return;

  setRetryInFlight(true);
  // Clear stale retry payload before attempting resend; failures repopulate in transport.
  setPendingChatRetry(null);
  try {
    // Remove the failed trailing assistant shell to avoid duplicate retry render rows.
    dropTrailingAssistantMessage();
    // Re-run the failed turn without appending a new user message.
    await retryLastResponse();
  } catch (error) {
    // Transport error handling owns user-facing messaging and retry repopulation.
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: dev-only visibility when retry throws unexpectedly
      console.error('[retryChatMessage]', error);
    }
  } finally {
    setRetryInFlight(false);
  }
}
