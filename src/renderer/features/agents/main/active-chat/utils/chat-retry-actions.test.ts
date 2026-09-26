import { describe, expect, it, vi } from 'vitest';
import type { PendingChatRetry } from '../../../atoms';
import { retryChatMessage } from './chat-retry-actions';

const retryPayload: PendingChatRetry = {
  chatId: 'chat-1',
  subChatId: 'sub-1',
  projectId: 'project-1',
  trigger: 'submit-message',
  messageId: undefined,
  errorCategory: 'UNKNOWN',
  errorText: 'provider error',
  createdAt: Date.now(),
};

describe('chat-retry-actions', () => {
  it('retryChatMessage no-ops when streaming', async () => {
    const retryLastResponse = vi.fn();
    const dropTrailingAssistantMessage = vi.fn();
    const setPending = vi.fn();
    const setInFlight = vi.fn();

    await retryChatMessage({
      isStreaming: true,
      retryInFlight: false,
      pendingChatRetry: retryPayload,
      retryLastResponse,
      dropTrailingAssistantMessage,
      setPendingChatRetry: setPending,
      setRetryInFlight: setInFlight,
    });

    expect(retryLastResponse).not.toHaveBeenCalled();
    expect(dropTrailingAssistantMessage).not.toHaveBeenCalled();
    expect(setPending).not.toHaveBeenCalled();
    expect(setInFlight).not.toHaveBeenCalled();
  });

  it('retryChatMessage retries last response without adding message', async () => {
    const retryLastResponse = vi.fn(async () => undefined);
    const dropTrailingAssistantMessage = vi.fn();
    const setPending = vi.fn();
    const setInFlight = vi.fn();

    await retryChatMessage({
      isStreaming: false,
      retryInFlight: false,
      pendingChatRetry: retryPayload,
      retryLastResponse,
      dropTrailingAssistantMessage,
      setPendingChatRetry: setPending,
      setRetryInFlight: setInFlight,
    });

    expect(setInFlight).toHaveBeenNthCalledWith(1, true);
    expect(setPending).toHaveBeenCalledWith(null);
    expect(dropTrailingAssistantMessage).toHaveBeenCalledTimes(1);
    expect(retryLastResponse).toHaveBeenCalledTimes(1);
    expect(setInFlight).toHaveBeenLastCalledWith(false);
  });

  it('retryChatMessage no-ops when retry is already in flight', async () => {
    const retryLastResponse = vi.fn();
    const dropTrailingAssistantMessage = vi.fn();
    const setPending = vi.fn();
    const setInFlight = vi.fn();

    await retryChatMessage({
      isStreaming: false,
      retryInFlight: true,
      pendingChatRetry: retryPayload,
      retryLastResponse,
      dropTrailingAssistantMessage,
      setPendingChatRetry: setPending,
      setRetryInFlight: setInFlight,
    });

    expect(retryLastResponse).not.toHaveBeenCalled();
    expect(dropTrailingAssistantMessage).not.toHaveBeenCalled();
    expect(setPending).not.toHaveBeenCalled();
    expect(setInFlight).not.toHaveBeenCalled();
  });

  it('retryChatMessage no-ops when pending retry payload is missing', async () => {
    const retryLastResponse = vi.fn();
    const dropTrailingAssistantMessage = vi.fn();
    const setPending = vi.fn();
    const setInFlight = vi.fn();

    await retryChatMessage({
      isStreaming: false,
      retryInFlight: false,
      pendingChatRetry: null,
      retryLastResponse,
      dropTrailingAssistantMessage,
      setPendingChatRetry: setPending,
      setRetryInFlight: setInFlight,
    });

    expect(retryLastResponse).not.toHaveBeenCalled();
    expect(dropTrailingAssistantMessage).not.toHaveBeenCalled();
    expect(setPending).not.toHaveBeenCalled();
    expect(setInFlight).not.toHaveBeenCalled();
  });
});
