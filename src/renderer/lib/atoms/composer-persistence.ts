import type { CodexSpeed } from '../../../shared/types/execution';

/** Where composer writes go (main owns them). Registered at app start so this lib never imports
 *  tRPC; with no persister registered (e.g. unit tests) writes are cache-only. */
export type ComposerField = 'modelId' | 'autoMode' | 'codexSpeed';
export type ComposerPatch = Partial<{ modelId: string; autoMode: boolean; codexSpeed: CodexSpeed }>;

type ComposerPersister = {
  chat: (chatId: string, patch: ComposerPatch) => void;
  thinking: (enabled: boolean) => void;
};

let persister: ComposerPersister | null = null;

export function registerComposerPersister(next: ComposerPersister): () => void {
  persister = next;
  return () => {
    if (persister === next) persister = null;
  };
}

export function persistComposerChat(chatId: string, patch: ComposerPatch): void {
  persister?.chat(chatId, patch);
}

export function persistThinking(enabled: boolean): void {
  persister?.thinking(enabled);
}
