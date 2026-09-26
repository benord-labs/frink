import type { SplitViewState } from '../atoms';
import { isChatVisibleInPanes } from '../main/active-chat/utils/split-pane-derivations';

/**
 * The completion-time view state, read LIVE in onFinish (the Chat is created once and
 * reused, so creation-time snapshots are stale — agent-execution-lifecycle decision).
 */
export type CompletionContext = {
  /** The finishing chat + subchat. */
  chatId: string;
  subChatId: string;
  /** Global sub-chat store snapshot: the focused chat and its active tab. */
  subStoreChatId: string | null;
  subStoreActiveSubChatId: string | null;
  /** Live split view (per renderer window). */
  splitView: SplitViewState;
  /** Single-pane selected chat. */
  selectedChatId: string | null;
  /** The renderer window currently has OS focus. */
  isWindowFocused: boolean;
  /** The user manually stopped the run. */
  wasManuallyAborted: boolean;
  /**
   * This turn belongs to a Flow run. Flow turns never chime per-node — the flow plays one
   * sound at finalization (see use-flow-execution-events.ts). Sidebar dots still mark.
   */
  isFlowDriven: boolean;
};

export type CompletionEffects = {
  markSubChatUnseen: boolean;
  markChatUnseen: boolean;
  /** Play the chime + fire the OS notification. */
  notifyCompletion: boolean;
};

/**
 * Pure decision for what fires when an agent run finishes. Kept free of store/atom
 * reads so the whole single-pane/split/window-focus matrix is unit-testable.
 */
export function resolveCompletionEffects(ctx: CompletionContext): CompletionEffects {
  // Viewing this subchat = the focused chat is this chat AND its active tab is this subchat.
  const isViewingThisSubChat =
    ctx.subStoreChatId === ctx.chatId && ctx.subStoreActiveSubChatId === ctx.subChatId;
  // Visible = occupies any pane (split) or is the selected chat (single-pane).
  const isChatVisible = isChatVisibleInPanes(ctx.splitView, ctx.selectedChatId, ctx.chatId);
  return {
    markSubChatUnseen: !isViewingThisSubChat,
    markChatUnseen: !isChatVisible,
    // Sound/OS-notify also require window focus: a visible pane in a backgrounded window is still
    // "away". Flow turns never chime per-node — the flow pings once at finalization.
    notifyCompletion:
      !ctx.isFlowDriven && (!isChatVisible || !ctx.isWindowFocused) && !ctx.wasManuallyAborted,
  };
}
