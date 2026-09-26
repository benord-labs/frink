// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { getDefaultLayout, getDefaultRatios, NEW_CHAT_PANE, type SplitViewState } from '../atoms';
import { fillNewChatInSplitState, resolveFillPaneIndex } from './new-chat-form.split-routing';

function makeState(chatIds: (string | null)[], activePaneIndex = 0): SplitViewState {
  return {
    chatIds,
    ratios: getDefaultRatios(chatIds.length),
    activePaneIndex,
    layout: getDefaultLayout(chatIds.length),
  };
}

// ---------------------------------------------------------------------------
// resolveFillPaneIndex
// ---------------------------------------------------------------------------

describe('resolveFillPaneIndex', () => {
  it('returns null for single-pane (length < 2)', () => {
    expect(resolveFillPaneIndex(['chat-a'], 'chat-x')).toBeNull();
    expect(resolveFillPaneIndex([], 'chat-x')).toBeNull();
  });

  it('returns null when chat ID is already in the split', () => {
    expect(resolveFillPaneIndex(['chat-a', 'chat-b'], 'chat-a')).toBeNull();
  });

  it('Priority 1 — returns the NEW_CHAT_PANE index when present', () => {
    expect(resolveFillPaneIndex(['chat-a', NEW_CHAT_PANE], 'chat-x')).toBe(1);
    expect(resolveFillPaneIndex([NEW_CHAT_PANE, 'chat-a'], 'chat-x')).toBe(0);
  });

  it('Priority 2 — returns first null index when no NEW_CHAT_PANE exists', () => {
    expect(resolveFillPaneIndex([null, null], 'chat-x')).toBe(0);
    expect(resolveFillPaneIndex(['chat-a', null], 'chat-x')).toBe(1);
  });

  it('returns null when no fillable pane exists', () => {
    expect(resolveFillPaneIndex(['chat-a', 'chat-b'], 'chat-x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fillNewChatInSplitState
// ---------------------------------------------------------------------------

describe('fillNewChatInSplitState', () => {
  it('returns prev unchanged for single-pane (length < 2)', () => {
    const state = makeState(['chat-a']);
    expect(fillNewChatInSplitState(state, 'chat-x')).toBe(state);
  });

  it('returns prev unchanged when chat ID is already present', () => {
    const state = makeState(['chat-a', 'chat-b']);
    expect(fillNewChatInSplitState(state, 'chat-a')).toBe(state);
  });

  it('Priority 1 — fills NEW_CHAT_PANE at index 1 and shifts activePaneIndex', () => {
    const state = makeState(['chat-a', NEW_CHAT_PANE], 0);
    const next = fillNewChatInSplitState(state, 'chat-x');
    expect(next.chatIds).toEqual(['chat-a', 'chat-x']);
    expect(next.activePaneIndex).toBe(1);
  });

  it('Priority 1 — fills NEW_CHAT_PANE at index 0 and shifts activePaneIndex', () => {
    const state = makeState([NEW_CHAT_PANE, 'chat-a'], 1);
    const next = fillNewChatInSplitState(state, 'chat-x');
    expect(next.chatIds).toEqual(['chat-x', 'chat-a']);
    expect(next.activePaneIndex).toBe(0);
  });

  it('Priority 2 — fills first null pane when no NEW_CHAT_PANE exists ([null, null])', () => {
    const state = makeState([null, null], 1);
    const next = fillNewChatInSplitState(state, 'chat-x');
    expect(next.chatIds).toEqual(['chat-x', null]);
    expect(next.activePaneIndex).toBe(0);
  });

  it('Priority 2 — fills first null pane with a real chat already present', () => {
    const state = makeState(['chat-a', null], 0);
    const next = fillNewChatInSplitState(state, 'chat-x');
    expect(next.chatIds).toEqual(['chat-a', 'chat-x']);
    expect(next.activePaneIndex).toBe(1);
  });

  it('returns prev when all panes are real chats and none is fillable', () => {
    const state = makeState(['chat-a', 'chat-b']);
    expect(fillNewChatInSplitState(state, 'chat-x')).toBe(state);
  });

  // Regression: existing split-mode new-chat flow must still work after Priority 2
  // (active-pane fallback) was removed. User in [realChat, NEW_CHAT_PANE], submits
  // from Pane 1 → Priority 1 must fill Pane 1.
  it('regression — split-mode submission fills the NEW_CHAT_PANE pane (not active pane)', () => {
    const state = makeState(['chat-a', NEW_CHAT_PANE], 0); // active = Pane 0
    const next = fillNewChatInSplitState(state, 'chat-x');
    expect(next.chatIds).toEqual(['chat-a', 'chat-x']); // Pane 1 filled, not Pane 0
    expect(next.activePaneIndex).toBe(1);
  });
});
