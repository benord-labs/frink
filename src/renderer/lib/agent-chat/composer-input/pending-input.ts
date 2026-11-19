import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { registerChatScopedFamily } from '../../atoms/atom-family-factory';

export type PendingPath = { path: string; type: 'file' | 'folder' };

/** Something on its way to this chat's composer: terminal text as an attachment, or picked paths as mentions. */
export type PendingComposerInput =
  | { kind: 'text'; text: string; label: string }
  | { kind: 'paths'; items: PendingPath[] };

/** Producers append, so two sends before the composer reads the queue both arrive. */
export const pendingComposerInputAtomFamily = registerChatScopedFamily(
  atomFamily((_chatId: string) => atom<PendingComposerInput[]>([])),
);
