// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { appStore } from '../../../../lib/jotai-store';
import { compactingSubChatsAtom } from '../../atoms';
import { setCompacting } from './index';

describe('setCompacting', () => {
  it('marks and clears a single sub-chat', () => {
    setCompacting('sub-1', true);
    expect(appStore.get(compactingSubChatsAtom).has('sub-1')).toBe(true);

    setCompacting('sub-1', false);
    expect(appStore.get(compactingSubChatsAtom).has('sub-1')).toBe(false);
  });

  it('leaves other sub-chats untouched', () => {
    setCompacting('sub-a', true);
    setCompacting('sub-b', true);
    setCompacting('sub-a', false);

    expect(appStore.get(compactingSubChatsAtom).has('sub-b')).toBe(true);
    setCompacting('sub-b', false);
  });

  // Clearing runs on every turn end, so the common case must not churn the Set reference and
  // re-render every pane subscribed to it.
  it('keeps the same Set when the flag already holds the requested value', () => {
    const before = appStore.get(compactingSubChatsAtom);
    setCompacting('never-compacted', false);
    expect(appStore.get(compactingSubChatsAtom)).toBe(before);
  });
});
