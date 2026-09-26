import { describe, expect, it } from 'vitest';
import { getPaneReplaceMenuItemKey } from './get-pane-replace-menu-item-key';

describe('getPaneReplaceMenuItemKey', () => {
  it('uses distinct keys for each pane when chat ids are all null (no React key collisions)', () => {
    const k0 = getPaneReplaceMenuItemKey(null, 0);
    const k1 = getPaneReplaceMenuItemKey(null, 1);
    const k2 = getPaneReplaceMenuItemKey(undefined, 2);
    expect(k0).toBe('replace-pane-empty-0');
    expect(k1).toBe('replace-pane-empty-1');
    expect(k2).toBe('replace-pane-empty-2');
    expect(new Set([k0, k1, k2]).size).toBe(3);
  });

  it('uses chat id in the key when the pane is bound to a chat', () => {
    expect(getPaneReplaceMenuItemKey('chat-abc', 0)).toBe('replace-pane-chat-abc');
  });
});
