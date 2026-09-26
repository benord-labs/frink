import { describe, expect, it } from 'vitest';
import type { SplitViewState } from '../../../atoms';
import type { SubChatMeta } from '../../../stores/sub-chat-store';
import { getEffectiveActiveSubChatId, isChatVisibleInPanes } from './split-pane-derivations';

const sc = (id: string, name: string): SubChatMeta => ({ id, name });

const splitView = (chatIds: (string | null)[]): SplitViewState => ({
  chatIds,
  ratios: [],
  activePaneIndex: 0,
  layout: 'horizontal',
});

describe('getEffectiveActiveSubChatId', () => {
  it('returns store activeSubChatId in single-pane mode', () => {
    const result = getEffectiveActiveSubChatId(false, [sc('sc-1', 'A')], 'sc-99');
    expect(result).toBe('sc-99');
  });

  it('normalises undefined store value to null in single-pane mode', () => {
    const result = getEffectiveActiveSubChatId(false, [sc('sc-1', 'A')], undefined);
    expect(result).toBeNull();
  });

  it('returns first subchat id in split view', () => {
    const result = getEffectiveActiveSubChatId(
      true,
      [sc('sc-1', 'First'), sc('sc-2', 'Second')],
      'sc-99',
    );
    expect(result).toBe('sc-1');
  });

  it('returns null in split view when subchats are empty', () => {
    const result = getEffectiveActiveSubChatId(true, [], 'sc-99');
    expect(result).toBeNull();
  });

  it('returns first subchat id in split view regardless of store value', () => {
    const result = getEffectiveActiveSubChatId(true, [sc('sc-5', 'X')], 'sc-99');
    expect(result).toBe('sc-5');
  });
});

describe('isChatVisibleInPanes', () => {
  it('single-pane: visible when the chat is the selected one', () => {
    expect(isChatVisibleInPanes(splitView(['chat-1']), 'chat-1', 'chat-1')).toBe(true);
  });

  it('single-pane: not visible when a different chat is selected', () => {
    expect(isChatVisibleInPanes(splitView(['chat-1']), 'chat-2', 'chat-1')).toBe(false);
  });

  it('single-pane: not visible when nothing is selected', () => {
    expect(isChatVisibleInPanes(splitView([]), null, 'chat-1')).toBe(false);
  });

  it('split: visible when the chat occupies any pane', () => {
    expect(isChatVisibleInPanes(splitView(['chat-1', 'chat-2']), 'chat-9', 'chat-2')).toBe(true);
  });

  it('split: not visible when the chat is in no pane', () => {
    expect(isChatVisibleInPanes(splitView(['chat-1', 'chat-2']), 'chat-1', 'chat-3')).toBe(false);
  });

  it('split: ignores null and NEW_CHAT_PANE placeholders when the real chat is present', () => {
    // '__new__' is the NEW_CHAT_PANE sentinel; the helper treats it as a non-matching string.
    expect(isChatVisibleInPanes(splitView([null, '__new__', 'chat-7']), null, 'chat-7')).toBe(true);
  });
});
