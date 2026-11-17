import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { registerChatScopedFamily } from '../atoms/atom-family-factory';

/** Terminal text on its way to this chat's composer, which takes it as an attachment. */
type PendingTerminalOutput = { text: string; label: string };

export const pendingTerminalOutputAtomFamily = registerChatScopedFamily(
  atomFamily((_chatId: string) => atom<PendingTerminalOutput | null>(null)),
);
