// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeListeners } from '../../../../../lib/stores/active-transport-registry';
import { chatSearchMatchesAtom } from '../../../search/chat-search-atoms';
import { getEffectiveStatus, useSearchScrollManager } from './MessageSyncManager';

const SUB = 'sub-effective-status';

afterEach(() => {
  activeListeners.delete(SUB);
});

describe('getEffectiveStatus', () => {
  it('reports streaming for an observed run even though useChat says ready', () => {
    // The wake-burst case: the arming turn's stream closed, so useChat has long since settled to
    // `ready`. Without the override there is no shimmer and every in-flight tool card renders as
    // interrupted while the agent is visibly still working.
    expect(getEffectiveStatus('ready', SUB, true)).toBe('streaming');
  });

  it('never masks an error with an observed run', () => {
    expect(getEffectiveStatus('error', SUB, true)).toBe('error');
  });

  it('still downgrades a stale streaming status when nothing is live', () => {
    expect(getEffectiveStatus('streaming', SUB, false)).toBe('ready');
    expect(getEffectiveStatus('submitted', SUB, false)).toBe('ready');
  });

  it('leaves a transport-owned run streaming', () => {
    activeListeners.set(SUB, () => {});

    expect(getEffectiveStatus('streaming', SUB, false)).toBe('streaming');
  });

  it('passes ready through untouched when nothing is live', () => {
    expect(getEffectiveStatus('ready', SUB, false)).toBe('ready');
  });
});

describe('useSearchScrollManager', () => {
  afterEach(() => {
    cleanup();
    getDefaultStore().set(chatSearchMatchesAtom, []);
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  // Without the release, a streaming chat's follow pulls the view back to the bottom.
  it('releases the follow before jumping to the current match', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const match = document.createElement('span');
    match.className = 'search-highlight-current';
    container.append(match);
    document.body.append(container);
    const calls: string[] = [];
    Object.defineProperty(match, 'scrollIntoView', { value: () => calls.push('jump') });
    getDefaultStore().set(chatSearchMatchesAtom, [
      { id: 'm:0:0', messageId: 'm', partIndex: 0, partType: 'text', offset: 0, length: 1 },
    ]);

    renderHook(() => useSearchScrollManager({ current: container }, () => calls.push('release')));
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(calls).toEqual(['release', 'jump']);
  });
});
