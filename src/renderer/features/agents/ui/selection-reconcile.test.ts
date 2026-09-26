import { describe, expect, it } from 'vitest';
import { isStaleSelection } from './selection-reconcile';

describe('isStaleSelection', () => {
  it('returns false while query is still loading', () => {
    expect(
      isStaleSelection({
        chatId: 'chat-1',
        isLoading: true,
        chatExists: false,
      }),
    ).toBe(false);
  });

  it('returns false when chat exists after query completes', () => {
    expect(
      isStaleSelection({
        chatId: 'chat-1',
        isLoading: false,
        chatExists: true,
      }),
    ).toBe(false);
  });

  it('returns true when query completed and chat does not exist (stale localStorage)', () => {
    expect(
      isStaleSelection({
        chatId: 'chat-deleted',
        isLoading: false,
        chatExists: false,
      }),
    ).toBe(true);
  });

  it('returns false when chatId is empty', () => {
    expect(
      isStaleSelection({
        chatId: '',
        isLoading: false,
        chatExists: false,
      }),
    ).toBe(false);
  });
});
