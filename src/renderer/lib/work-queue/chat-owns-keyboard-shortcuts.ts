import type { Store } from 'jotai/vanilla/store';
import { exitTransientDestinationForNavigationAtom } from '../atoms';

const WORK_QUEUE_DESTINATION_SELECTOR = '[data-agents-destination="workqueue"]';

/** Retained chat surfaces own global shortcuts only while chat is the visible destination; pass
 *  an element inside the chat to disown them while it is hidden (e.g. behind a side panel). */
export function chatOwnsKeyboardShortcuts(chatElement?: Element | null): boolean {
  if (chatElement?.checkVisibility?.({ visibilityProperty: true }) === false) return false;
  return document.querySelector(WORK_QUEUE_DESTINATION_SELECTOR) === null;
}

/** The chat column SplitPane renders for split pane `paneIndex`; null outside split view. */
export function splitPaneChat(paneIndex: number | undefined): Element | null {
  if (paneIndex === undefined) return null;
  return document.querySelector(`[data-pane-index="${paneIndex}"] [data-pane-chat]`);
}

/** Transfer destination ownership before a retained chat shortcut performs its action. */
export function runChatShortcutAction(store: Store, canRun: boolean, action: () => void): boolean {
  if (!canRun) return false;
  store.set(exitTransientDestinationForNavigationAtom);
  action();
  return true;
}
