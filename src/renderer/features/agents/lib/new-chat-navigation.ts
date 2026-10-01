/* eslint-disable project-structure/folder-structure */
import { atom, type Getter, type Setter } from 'jotai';
import { normalizeModelIdForExecutionAccount } from '../../../../shared/lib/models';
import type { CodexSpeed } from '../../../../shared/types/execution';
import { leaveOverlayStackForChatSurfaceAtom } from '../../../lib/atoms';
import {
  agentsMobileViewModeAtom,
  autoModePerChatAtomFamily,
  chatModeAtomFamily,
  justCreatedIdsAtom,
  lastSelectedModelIdAtomFamily,
  newChatPaneChatModeMapAtom,
  newChatPaneModelMapAtom,
  newChatPaneProjectMapAtom,
  newChatPaneWorkModeMapAtom,
  type SplitViewState,
  selectedAgentChatIdAtom,
  splitViewAtom,
} from '../atoms';
import { getEffectiveModelIdForPane } from '../hooks/use-effective-model-for-pane';
import { getEffectiveChatModeForPane } from '../hooks/use-effective-plan-mode-for-pane';
import { fillNewChatInSplitState, resolveFillPaneIndex } from '../main/new-chat-form.split-routing';
import { useAgentSubChatStore } from '../stores/sub-chat-store';
import { codexSpeedAtomFamily } from '../../../lib/atoms/codex-speed';
import { getUrlParam } from '../../../lib/utils/url-params';
import { newChatDraftKey, replaceDraftText } from './drafts';

type SeedOptions = {
  /** Whether the resolved execution account is a Codex account (coerces the seeded model id). */
  isCodexAccount: boolean;
  /** First sub-chat id, if present — seeds its mode before the tRPC query hydrates the store. */
  subChatId?: string;
  /** Staged manual Auto Mode state from New Chat. Defaults on for all fresh chats. */
  autoModeEnabled?: boolean;
  /** Staged Codex speed from New Chat; applied only on a Codex account. Defaults to standard. */
  codexSpeed?: CodexSpeed;
};

/** Toggles one New Chat form stages before its chat exists; `capture` freezes them at send, so a
 *  toggle flipped while the create is in flight cannot reach the chat being created. */
export function createNewChatStaging() {
  const autoMode = { current: true };
  const codexSpeed = { current: 'standard' as CodexSpeed };
  const pending = { autoMode: true, codexSpeed: 'standard' as CodexSpeed };
  const capture = () =>
    Object.assign(pending, { autoMode: autoMode.current, codexSpeed: codexSpeed.current });
  return { autoMode, codexSpeed, pending, capture };
}

/**
 * Navigation + per-chat seeding shared by every new-chat entry point (the full NewChatForm and
 * the goal-first build flow). Selects the new chat, fills the active split pane, seeds the
 * per-chat model/mode atoms from the effective new-chat state, and clears the pane maps for the
 * filled pane. Takes a Jotai get/set pair so it works from a mutation callback or a hook.
 *
 * Deliberately does NOT clear editor/image/pasted/worktree/sentinel state — that is state only
 * the full form creates; callers own it. Cache invalidation (`utils.chats.list`) is also the
 * caller's job (it needs the tRPC react utils).
 */
export function seedNewChatNavigation(
  get: Getter,
  set: Setter,
  chatId: string,
  { isCodexAccount, subChatId, autoModeEnabled = true, codexSpeed = 'standard' }: SeedOptions,
): void {
  set(selectedAgentChatIdAtom, chatId);

  // Snapshot the fill target before setSplitView mutates chatIds — seeding reads it.
  const prevSplit = get(splitViewAtom);
  const filledPaneIndex = resolveFillPaneIndex(prevSplit.chatIds, chatId);
  const effectiveChatMode = getEffectiveChatModeForPane(get, filledPaneIndex);

  set(splitViewAtom, (prev: SplitViewState) => fillNewChatInSplitState(prev, chatId));

  const rawModelId = getEffectiveModelIdForPane(get, filledPaneIndex);
  set(
    lastSelectedModelIdAtomFamily(chatId),
    normalizeModelIdForExecutionAccount(isCodexAccount, rawModelId),
  );
  set(chatModeAtomFamily(chatId), effectiveChatMode);
  set(autoModePerChatAtomFamily(chatId), autoModeEnabled);
  set(codexSpeedAtomFamily(chatId), isCodexAccount ? codexSpeed : 'standard');

  if (subChatId) {
    useAgentSubChatStore.getState().updateSubChatMode(subChatId, effectiveChatMode, chatId);
  }

  if (filledPaneIndex !== null) {
    const paneIndex = filledPaneIndex;
    const omit = <T>(prev: Record<number, T>): Record<number, T> => {
      const next = { ...prev };
      delete next[paneIndex];
      return next;
    };
    set(newChatPaneProjectMapAtom, omit);
    set(newChatPaneWorkModeMapAtom, omit);
    set(newChatPaneChatModeMapAtom, omit);
    set(newChatPaneModelMapAtom, omit);
  }

  const ids = subChatId ? [chatId, subChatId] : [chatId];
  set(justCreatedIdsAtom, (prev: Set<string>) => new Set([...prev, ...ids]));
}

/**
 * Prefill, not send: the send stays the user's explicit act. One destination,
 * always — the SINGLE-PANE new-chat home, because a seed into a split pane or
 * behind an open chat is invisible and resurfaces later as text the user never
 * typed. The one holdout is a flow editor beneath Settings: its stack is never
 * dismissed on a caller's behalf, so the seed waits in the home draft instead.
 */
export const seedNewChatPromptAtom = atom(null, (get, set, prompt: string) => {
  replaceDraftText(newChatDraftKey(0), prompt, true);

  const split = get(splitViewAtom);
  if (split.chatIds.length > 0) {
    set(splitViewAtom, {
      chatIds: [],
      ratios: [],
      activePaneIndex: 0,
      layout: split.layout,
    });
    // The collapse destroys every pane, so staged per-pane new-chat state goes
    // with it — the same reset normal split closure performs.
    set(newChatPaneProjectMapAtom, {});
    set(newChatPaneWorkModeMapAtom, {});
    set(newChatPaneChatModeMapAtom, {});
    set(newChatPaneModelMapAtom, {});
  }
  set(selectedAgentChatIdAtom, null);

  // AgentsContent re-selects the chat param (query in dev, hash in packaged
  // file:// loads — see getUrlParam) on every mount, and it outlives the
  // unmounted chat surface — without clearing both carriers, the remount would
  // immediately re-open that chat and bury the seeded composer.
  if (getUrlParam('chat') !== null) {
    const url = new URL(window.location.href);
    url.searchParams.delete('chat');
    const hashParams = new URLSearchParams(url.hash.slice(1));
    hashParams.delete('chat');
    url.hash = hashParams.toString();
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }

  // The narrow layout's default view is the chat list, where the composer is invisible — mirror
  // the sidebar's New Chat and land on the chat view.
  set(agentsMobileViewModeAtom, 'chat');
  set(leaveOverlayStackForChatSurfaceAtom);
});
