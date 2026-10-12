import type { Store } from 'jotai/vanilla/store';
import { exitTransientDestinationForNavigationAtom } from '../atoms';

/** Work Queue and Settings render over the retained chat and mark themselves with this. */
const COVERING_DESTINATION_SELECTOR = '[data-agents-destination]';

/** Retained chat surfaces own global shortcuts only while chat is the visible destination; pass
 *  an element inside the chat to disown them while it is hidden (e.g. behind a side panel). */
export function chatOwnsKeyboardShortcuts(chatElement?: Element | null): boolean {
  if (chatElement?.checkVisibility?.({ visibilityProperty: true }) === false) return false;
  return document.querySelector(COVERING_DESTINATION_SELECTOR) === null;
}

/** The chat column SplitPane renders for split pane `paneIndex`; null outside split view. */
export function splitPaneChat(paneIndex: number | undefined): Element | null {
  if (paneIndex === undefined) return null;
  return document.querySelector(`[data-pane-index="${paneIndex}"] [data-pane-chat]`);
}

/** Whether the focused chat is on screen: the active split pane's chat, else the single pane's.
 *  A compact pane's side panel hides its chat, and a hidden chat must not be acted on. */
export function focusedChatOwnsShortcuts(activePaneIndex: number | undefined): boolean {
  return chatOwnsKeyboardShortcuts(splitPaneChat(activePaneIndex));
}

/** Transfer destination ownership before a retained chat shortcut performs its action. */
export function runChatShortcutAction(store: Store, canRun: boolean, action: () => void): boolean {
  if (!canRun) return false;
  store.set(exitTransientDestinationForNavigationAtom);
  action();
  return true;
}
