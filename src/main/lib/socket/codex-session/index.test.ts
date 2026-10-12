import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCodexSession,
  beginCodexTurn,
  clearCodexSubChatSession,
  endCodexTurn,
  getCodexSession,
  setCodexSession,
} from './index';

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

  it('clears a single sub-chat without touching its siblings', () => {
    setCodexSession('chat-a', 'sub-1', 'sess-1');
    setCodexSession('chat-a', 'sub-2', 'sess-2');

    clearCodexSubChatSession('sub-1');

    expect(getCodexSession('sub-1')).toBeUndefined();
    expect(getCodexSession('sub-2')).toBe('sess-2');
    // The parent-chat link went with it: a later chat-wide clear still clears the sibling.
    clearCodexSession('chat-a');
    expect(getCodexSession('sub-2')).toBeUndefined();
  });

  it('drops a write from a turn whose chat was cleared mid-turn', () => {
    const stale = beginCodexTurn('chat-a');
    clearCodexSession('chat-a');
    const fresh = beginCodexTurn('chat-a');

    setCodexSession('chat-a', 'sub-1', 'sess-stale', stale);
    expect(getCodexSession('sub-1')).toBeUndefined();
    setCodexSession('chat-a', 'sub-1', 'sess-fresh', fresh);
    expect(getCodexSession('sub-1')).toBe('sess-fresh');
    endCodexTurn(stale);
    endCodexTurn(fresh);
  });

  it("leaves a turn's write alone when a different chat is cleared", () => {
    const turn = beginCodexTurn('chat-a');
    clearCodexSession('chat-b');

    setCodexSession('chat-a', 'sub-1', 'sess-1', turn);
    expect(getCodexSession('sub-1')).toBe('sess-1');
    endCodexTurn(turn);
  });

  it('stops tracking a turn once it ends', () => {
    const turn = beginCodexTurn('chat-a');
    endCodexTurn(turn);
    endCodexTurn(turn); // Idempotent: a second release is a no-op.
    clearCodexSession('chat-a');

    expect(turn.cleared).toBe(false);
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
