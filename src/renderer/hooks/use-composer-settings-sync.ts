import { useEffect } from 'react';
import { trpc, trpcClient } from '@/lib/trpc';
import { writeComposerCache } from '../lib/atoms/atom-family-factory';
import { collectComposerImport } from '../lib/atoms/composer-import';
import { registerComposerPersister } from '../lib/atoms/composer-persistence';
import { extendedThinkingCacheAtom } from '../lib/atoms';
import { appStore } from '../lib/jotai-store';
import { isDesktopApp } from '../lib/utils/platform';
import type { CodexSpeed } from '../../shared/types/execution';

const IMPORTED_KEY = 'agents:composerSettingsImported:v1';

type ChatComposerValues = { modelId: string; autoMode: boolean; codexSpeed: CodexSpeed };
/** Mirrors main's `ComposerChangedPayload` (the renderer never imports main). */
type ComposerChange =
  | { kind: 'chat'; chatId: string; settings: ChatComposerValues }
  | { kind: 'thinking'; thinkingEnabled: boolean }
  | { kind: 'accounts'; projectId: string | null };

function applyChat(chatId: string, settings: ChatComposerValues): void {
  writeComposerCache(chatId, settings);
}

async function refetchChat(chatId: string): Promise<void> {
  try {
    const { thinkingEnabled: _thinking, ...settings } =
      await trpcClient.chats.getComposerSettings.query({ chatId });
    applyChat(chatId, settings);
  } catch {
    // The chat is gone or main is unreachable; the next echo or boot hydration corrects it.
  }
}

/** Adopt old localStorage choices once, then load main's values into this window's cache. */
async function importThenHydrate(): Promise<void> {
  if (localStorage.getItem(IMPORTED_KEY) === null) {
    await trpcClient.chats.importComposerSettings.mutate(collectComposerImport());
    localStorage.setItem(IMPORTED_KEY, '1');
  }
  const { chats, thinkingEnabled } = await trpcClient.chats.listComposerSettings.query();
  for (const { chatId, ...settings } of chats) applyChat(chatId, settings);
  appStore.set(extendedThinkingCacheAtom, thinkingEnabled);
}

/** Keeps this window's composer in step with main: registers the write path, runs the one-time
 *  import, hydrates, and mirrors every confirmed change (including the phone's). */
export function useComposerSettingsSync(): void {
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!isDesktopApp()) return;

    const unregister = registerComposerPersister({
      chat: (chatId, patch) => {
        // Main's echo confirms the value; on failure resync so the optimistic write can't linger.
        trpcClient.chats.updateComposerSettings
          .mutate({ chatId, patch })
          .catch(() => refetchChat(chatId));
      },
      thinking: (enabled) => {
        trpcClient.chats.setThinkingEnabled.mutate({ enabled }).catch(() => {
          void trpcClient.chats.listComposerSettings
            .query()
            .then(({ thinkingEnabled }) => appStore.set(extendedThinkingCacheAtom, thinkingEnabled))
            .catch(() => {});
        });
      },
    });

    // Subscribe before hydrating: main's replies and broadcasts share one ordered channel, so an
    // echo can never be overwritten by an older hydration read.
    const unsubscribe = window.desktopApi?.on('composer:changed', (data) => {
      const change = data as ComposerChange | undefined;
      if (change?.kind === 'chat') applyChat(change.chatId, change.settings);
      else if (change?.kind === 'thinking')
        appStore.set(extendedThinkingCacheAtom, change.thinkingEnabled);
      else if (change?.kind === 'accounts') {
        void utils.claudeCode.getResolvedAccount.invalidate();
        void utils.claudeCode.listAccounts.invalidate();
      }
    });

    // A failed import leaves its flag unset, so the next launch retries; until then this window
    // keeps its cached values and still mirrors every echo.
    importThenHydrate().catch(() => {});

    return () => {
      unregister();
      unsubscribe?.();
    };
  }, [utils]);
}
