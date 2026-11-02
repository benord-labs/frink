import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { registerChatScopedFamily } from '../atoms/atom-family-factory';

/** Per-chat: the ids of the other projects added to the chat's file tree, in the order they were
 *  added. Held in memory only, so the list is gone after a restart and grants the agent nothing. */
export const chatTreeProjectIdsAtomFamily = registerChatScopedFamily(
  atomFamily((_chatId: string) => atom<string[]>([])),
);

type TreeProjectChange = { chatId: string; projectId: string };

/** Adds a project to the end of the chat's list; one already there stays where it is. */
export const addChatTreeProjectAtom = atom(
  null,
  (get, set, { chatId, projectId }: TreeProjectChange) => {
    const ids = get(chatTreeProjectIdsAtomFamily(chatId));
    if (ids.includes(projectId)) return;
    set(chatTreeProjectIdsAtomFamily(chatId), [...ids, projectId]);
  },
);

/** Takes a project out of the chat's list; one that isn't there changes nothing. */
export const removeChatTreeProjectAtom = atom(
  null,
  (get, set, { chatId, projectId }: TreeProjectChange) => {
    const ids = get(chatTreeProjectIdsAtomFamily(chatId));
    if (!ids.includes(projectId)) return;
    set(
      chatTreeProjectIdsAtomFamily(chatId),
      ids.filter((id) => id !== projectId),
    );
  },
);
