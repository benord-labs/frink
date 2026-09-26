import { describe, expect, it, vi } from 'vitest';

import { settleChatOwnedFlowDeletion } from '.';

describe('settleChatOwnedFlowDeletion', () => {
  it('cancels against the chat ownership returned by each transaction attempt', async () => {
    const cancelFlowRunForChatDeletion = vi.fn().mockResolvedValue(undefined);
    const attemptDelete = vi
      .fn()
      .mockResolvedValueOnce({
        deleted: false,
        unsettledRunIds: ['run-1'],
        chatIds: ['chat-created-during-delete'],
      })
      .mockResolvedValueOnce({ deleted: true });

    await settleChatOwnedFlowDeletion(attemptDelete, cancelFlowRunForChatDeletion);

    expect(cancelFlowRunForChatDeletion).toHaveBeenCalledWith('run-1', [
      'chat-created-during-delete',
    ]);
  });
});
