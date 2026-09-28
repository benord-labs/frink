/**
 * The one-time adoption of composer choices a window made before main owned them (they lived only
 * in that window's localStorage). Pure so the sync hook and its tests share it without tRPC.
 */
import { appStore } from '../jotai-store';
import { readComposerCacheMaps } from './atom-family-factory';
import type { ComposerPatch } from './composer-persistence';
import { extendedThinkingCacheAtom } from './index';

const THINKING_STORAGE_KEY = 'preferences:extended-thinking-enabled';
const IMPORT_LIMIT = 5000;

/** This window's pre-main composer choices, shaped for `importComposerSettings`. */
export function collectComposerImport(): {
  entries: Array<{ chatId: string } & ComposerPatch>;
  thinkingEnabled?: boolean;
} {
  const maps = readComposerCacheMaps();
  const byChat = new Map<string, ComposerPatch>();
  const add = <K extends keyof ComposerPatch>(
    field: K,
    isValid: (value: unknown) => value is ComposerPatch[K],
  ) => {
    for (const [chatId, value] of Object.entries(maps[field] ?? {})) {
      if (!isValid(value)) continue;
      byChat.set(chatId, { ...byChat.get(chatId), [field]: value });
    }
  };
  add('modelId', (v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200);
  add('autoMode', (v): v is boolean => typeof v === 'boolean');
  add('codexFastMode', (v): v is boolean => typeof v === 'boolean');
  const entries = [...byChat].slice(0, IMPORT_LIMIT).map(([chatId, patch]) => ({
    chatId,
    ...patch,
  }));
  // Only a Thinking choice the user actually made; an untouched default must not be pinned.
  const thinkingEnabled =
    localStorage.getItem(THINKING_STORAGE_KEY) !== null
      ? appStore.get(extendedThinkingCacheAtom)
      : undefined;
  return { entries, ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}) };
}
