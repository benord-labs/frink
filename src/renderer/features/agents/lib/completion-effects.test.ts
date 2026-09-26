import { describe, expect, it } from 'vitest';
import type { SplitViewState } from '../atoms';
import { type CompletionContext, resolveCompletionEffects } from './completion-effects';

const split = (chatIds: (string | null)[], activePaneIndex = 0): SplitViewState => ({
  chatIds,
  ratios: [],
  activePaneIndex,
  layout: 'horizontal',
});

// Default = single-pane, actively viewing chat-A / sub-1, window focused, not aborted.
const ctx = (overrides: Partial<CompletionContext> = {}): CompletionContext => ({
  chatId: 'chat-A',
  subChatId: 'sub-1',
  subStoreChatId: 'chat-A',
  subStoreActiveSubChatId: 'sub-1',
  splitView: split([]),
  selectedChatId: 'chat-A',
  isWindowFocused: true,
  wasManuallyAborted: false,
  isFlowDriven: false,
  ...overrides,
});

describe('resolveCompletionEffects', () => {
  describe('single-pane', () => {
    it('actively viewing the chat + subchat: nothing fires', () => {
      expect(resolveCompletionEffects(ctx())).toEqual({
        markSubChatUnseen: false,
        markChatUnseen: false,
        notifyCompletion: false,
      });
    });

    it('viewing the chat but a different subchat tab: only the subchat dot marks', () => {
      expect(resolveCompletionEffects(ctx({ subStoreActiveSubChatId: 'sub-2' }))).toEqual({
        markSubChatUnseen: true,
        markChatUnseen: false,
        notifyCompletion: false,
      });
    });

    it('a different chat is selected (away): marks both dots and notifies', () => {
      expect(
        resolveCompletionEffects(ctx({ selectedChatId: 'chat-B', subStoreChatId: 'chat-B' })),
      ).toEqual({
        markSubChatUnseen: true,
        markChatUnseen: true,
        notifyCompletion: true,
      });
    });

    it('viewing the chat but the window is backgrounded: notifies without marking a dot', () => {
      expect(resolveCompletionEffects(ctx({ isWindowFocused: false }))).toEqual({
        markSubChatUnseen: false,
        markChatUnseen: false,
        notifyCompletion: true,
      });
    });

    it('manual abort suppresses the notification even when away', () => {
      expect(
        resolveCompletionEffects(
          ctx({ selectedChatId: 'chat-B', isWindowFocused: false, wasManuallyAborted: true }),
        ).notifyCompletion,
      ).toBe(false);
    });
  });

  describe('split / multi-pane', () => {
    it('finishing chat sits in a visible NON-active pane (focused): no sound, no chat dot', () => {
      // The reported bug: chat-A visible in pane 1 while pane 0 (chat-B) is active.
      const effects = resolveCompletionEffects(
        ctx({
          splitView: split(['chat-B', 'chat-A'], 0),
          selectedChatId: 'chat-B',
          subStoreChatId: 'chat-B',
        }),
      );
      expect(effects.notifyCompletion).toBe(false);
      expect(effects.markChatUnseen).toBe(false);
    });

    it('finishing chat is in NO open pane (focused): marks chat dot and notifies', () => {
      const effects = resolveCompletionEffects(
        ctx({
          splitView: split(['chat-B', 'chat-C'], 0),
          selectedChatId: 'chat-B',
          subStoreChatId: 'chat-B',
        }),
      );
      expect(effects.notifyCompletion).toBe(true);
      expect(effects.markChatUnseen).toBe(true);
    });

    it('finishing chat is visible in a pane but the window is backgrounded: still notifies', () => {
      const effects = resolveCompletionEffects(
        ctx({ splitView: split(['chat-A', 'chat-B'], 1), isWindowFocused: false }),
      );
      expect(effects.notifyCompletion).toBe(true);
      expect(effects.markChatUnseen).toBe(false);
    });
  });

  describe('flow-driven turns', () => {
    it('never notifies per node, even when away (flow chimes once at finalization)', () => {
      const effects = resolveCompletionEffects(
        ctx({
          isFlowDriven: true,
          selectedChatId: 'chat-B',
          subStoreChatId: 'chat-B',
          isWindowFocused: false,
        }),
      );
      expect(effects.notifyCompletion).toBe(false);
      // Sidebar dots still mark so flow progress stays visible.
      expect(effects.markChatUnseen).toBe(true);
      expect(effects.markSubChatUnseen).toBe(true);
    });

    it('does not change notify when the flow chat is being viewed (already silent)', () => {
      expect(resolveCompletionEffects(ctx({ isFlowDriven: true })).notifyCompletion).toBe(false);
    });
  });
});
