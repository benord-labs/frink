import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { registerChatScopedFamily } from '../../atoms/atom-family-factory';

type ChatContextFile = { name: string; path: string };

// Each chat keeps the file last opened from it as composer context, across chat switches and
// after the tab closes: "I opened that file from this chat".
const chatContextFileValueAtomFamily = registerChatScopedFamily(
  atomFamily((_chatId: string) => atom<ChatContextFile | null>(null)),
);

/** Per-chat: whether the user removed the context file from what the composer sends */
export const chatContextFileDismissedAtomFamily = registerChatScopedFamily(
  atomFamily((_chatId: string) => atom<boolean>(false)),
);

/** Per-chat: the file last opened from this chat. Pointing it at another path clears the
 *  dismissal, so removing one file never hides the next; a same-path write keeps it. */
export const chatContextFileAtomFamily = registerChatScopedFamily(
  atomFamily((chatId: string) =>
    atom(
      (get) => get(chatContextFileValueAtomFamily(chatId)),
      (get, set, next: ChatContextFile | null) => {
        if (get(chatContextFileValueAtomFamily(chatId))?.path !== next?.path) {
          set(chatContextFileDismissedAtomFamily(chatId), false);
        }
        set(chatContextFileValueAtomFamily(chatId), next);
      },
    ),
  ),
);
