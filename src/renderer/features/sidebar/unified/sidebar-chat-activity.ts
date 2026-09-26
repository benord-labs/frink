import { atom } from 'jotai';
import { appStore } from '../../../lib/jotai-store';

/** Bump payload so UnifiedSidebar can reorder `folderChatsByKey` without refetching listByFolder. */
type SidebarChatActivityBump = { chatId: string; at: number };

export const sidebarChatActivityBumpAtom = atom<SidebarChatActivityBump | null>(null);

/** Call when user sends a message so the unified sidebar moves that chat to the top (by updatedAt). */
export function notifySidebarChatActivity(chatId: string): void {
  appStore.set(sidebarChatActivityBumpAtom, { chatId, at: Date.now() });
}
