import { afterEach, describe, expect, it } from 'vitest';
import { clearCodexSession, getCodexSession, setCodexSession } from './index';

const CACHE_CAP = 100;

describe('codex session cache', () => {
  afterEach(() => {
    clearCodexSession('chat-a');
    clearCodexSession('chat-b');
    clearCodexSession('chat-lru');
  });

  it('returns the cached session per sub-chat', () => {
    setCodexSession('chat-a', 'sub-1', 'sess-1');
    setCodexSession('chat-a', 'sub-2', 'sess-2');

    expect(getCodexSession('sub-1')).toBe('sess-1');
    expect(getCodexSession('sub-2')).toBe('sess-2');
    expect(getCodexSession('unknown')).toBeUndefined();
  });

  it('clears only the sub-chats owned by the given chat', () => {
    setCodexSession('chat-a', 'sub-1', 'sess-1');
    setCodexSession('chat-a', 'sub-2', 'sess-2');
    setCodexSession('chat-b', 'sub-3', 'sess-3');

    clearCodexSession('chat-a');

    expect(getCodexSession('sub-1')).toBeUndefined();
    expect(getCodexSession('sub-2')).toBeUndefined();
    expect(getCodexSession('sub-3')).toBe('sess-3');
  });

  it('evicts the oldest entry once the cap is reached', () => {
    for (let i = 0; i < CACHE_CAP; i++) setCodexSession('chat-lru', `sub-${i}`, `sess-${i}`);
    setCodexSession('chat-lru', 'sub-new', 'sess-new');

    expect(getCodexSession('sub-0')).toBeUndefined();
    expect(getCodexSession('sub-1')).toBe('sess-1');
    expect(getCodexSession('sub-new')).toBe('sess-new');
  });

  it('refreshes recency when an existing sub-chat is re-cached', () => {
    for (let i = 0; i < CACHE_CAP; i++) setCodexSession('chat-lru', `sub-${i}`, `sess-${i}`);
    setCodexSession('chat-lru', 'sub-0', 'sess-0b');
    setCodexSession('chat-lru', 'sub-new', 'sess-new');

    expect(getCodexSession('sub-0')).toBe('sess-0b');
    expect(getCodexSession('sub-1')).toBeUndefined();
  });
});
