import { describe, expect, it } from 'vitest';
import { contextUsageFromMessages, messageTokenDataEqual } from './agent-context-indicator';

describe('contextUsageFromMessages', () => {
  it('takes the latest reported level instead of summing turns', () => {
    const messages = [
      { metadata: { contextTokens: 150_000, contextWindow: 200_000 } },
      { metadata: { contextTokens: 20_000, contextWindow: 1_000_000, promptCacheExpiresAt: 42 } },
      { metadata: undefined },
      { metadata: { sessionId: 's' } },
    ];
    expect(contextUsageFromMessages(messages)).toEqual({
      contextTokens: 20_000,
      contextWindow: 1_000_000,
      promptCacheExpiresAt: 42,
    });
  });

  it('reports an unknown window before any turn has reported usage', () => {
    expect(contextUsageFromMessages([{ metadata: { inputTokens: 5 } }])).toEqual({
      contextTokens: 0,
      contextWindow: null,
      promptCacheExpiresAt: null,
    });
  });
});

describe('messageTokenDataEqual', () => {
  it('compares every field', () => {
    const base = { contextTokens: 10, contextWindow: 100, promptCacheExpiresAt: 5 };
    expect(messageTokenDataEqual(base, { ...base })).toBe(true);
    expect(messageTokenDataEqual(base, { ...base, contextTokens: 11 })).toBe(false);
    expect(messageTokenDataEqual(base, { ...base, contextWindow: null })).toBe(false);
    expect(messageTokenDataEqual(base, { ...base, promptCacheExpiresAt: null })).toBe(false);
  });
});
