/** Main owns each chat's composer settings so every window and the phone drive it alike. Writes
 *  echo the confirmed values; repo calls are synchronous, so write → re-read → echo can't interleave. */
import {
  buildExecutionSettings,
  type ComposerSettings,
  type ExecutionAccountKind,
  resolveComposerSettings,
} from '../../../shared/lib/execution-settings';
import type { ExecutionSettings } from '../../../shared/types/execution';
import log from 'electron-log';
import { getDatabase } from '../db';
import {
  type ComposerSettingsPatch,
  fillMissingComposerSettings,
  getChatComposerSettings,
  getPreference,
  listStoredComposerSettings,
  setPreference,
  type StoredComposerSettings,
  updateChatComposerSettings,
} from '../db/repos/composer-settings';
import { broadcastToRenderer } from '../socket/client';

export type { ComposerSettingsPatch };

/** Per-chat values a window mirrors into its composer (Thinking travels separately). */
export type ChatComposerValues = Omit<ComposerSettings, 'thinkingEnabled'>;

/** One channel for everything a composer mirrors: a chat's settings, Thinking, or accounts. */
export type ComposerChangedPayload =
  | { kind: 'chat'; chatId: string; settings: ChatComposerValues }
  | { kind: 'thinking'; thinkingEnabled: boolean }
  | { kind: 'accounts'; projectId: string | null };

export function broadcastComposerChange(payload: ComposerChangedPayload): void {
  broadcastToRenderer('composer:changed', payload);
}

const THINKING_KEY = 'composer.thinkingEnabled';

function chatValues(row: StoredComposerSettings): ChatComposerValues {
  const { thinkingEnabled: _thinking, ...values } = resolveComposerSettings(row, undefined);
  return values;
}

function echo(chatId: string, row: StoredComposerSettings): ChatComposerValues {
  const settings = chatValues(row);
  broadcastComposerChange({ kind: 'chat', chatId, settings });
  return settings;
}

function getThinkingEnabled(): boolean {
  return getPreference<boolean>(getDatabase(), THINKING_KEY) ?? true;
}

/** A chat's resolved composer settings; `null` when the chat does not exist. */
export function readComposerSettings(chatId: string): ComposerSettings | null {
  const row = getChatComposerSettings(getDatabase(), chatId);
  return row ? resolveComposerSettings(row, getThinkingEnabled()) : null;
}

/** Every chat that has a stored value, resolved (windows hydrate their cache from this at boot). */
export function listComposerSettings(): {
  chats: Array<{ chatId: string } & ChatComposerValues>;
  thinkingEnabled: boolean;
} {
  return {
    chats: listStoredComposerSettings(getDatabase()).map(({ chatId, ...row }) => ({
      chatId,
      ...chatValues(row),
    })),
    thinkingEnabled: getThinkingEnabled(),
  };
}

/** Writes the patch and echoes the confirmed values; `null` when the chat does not exist. */
export function updateComposerSettings(
  chatId: string,
  patch: ComposerSettingsPatch,
): ComposerSettings | null {
  const row = updateChatComposerSettings(getDatabase(), chatId, patch);
  if (!row) return null;
  return { ...echo(chatId, row), thinkingEnabled: getThinkingEnabled() };
}

export function setThinkingEnabled(enabled: boolean): boolean {
  setPreference(getDatabase(), THINKING_KEY, enabled);
  const thinkingEnabled = getThinkingEnabled();
  broadcastComposerChange({ kind: 'thinking', thinkingEnabled });
  return thinkingEnabled;
}

/**
 * One-time adoption of a window's pre-existing localStorage choices. Fills only values nobody has
 * set yet, so re-runs and several windows importing at once are harmless.
 */
export function importComposerSettings(input: {
  entries: Array<{ chatId: string } & ComposerSettingsPatch>;
  thinkingEnabled?: boolean;
}): void {
  const db = getDatabase();
  for (const { chatId, settings } of fillMissingComposerSettings(db, input.entries)) {
    echo(chatId, settings);
  }
  if (input.thinkingEnabled !== undefined && getPreference(db, THINKING_KEY) === undefined) {
    setThinkingEnabled(input.thinkingEnabled);
  }
}

/** Settings for a send that carried none (the phone): the chat's stored choices, built as the
 *  desktop builds them. Best-effort: on failure the turn runs on the CLI defaults. */
export function storedExecutionSettings(
  chatId: string | undefined,
  credentialType: string | undefined,
): ExecutionSettings | undefined {
  if (!chatId) return undefined;
  try {
    const settings = readComposerSettings(chatId);
    const account: ExecutionAccountKind = credentialType === 'codex' ? 'codex' : 'claude-code';
    return settings ? buildExecutionSettings(account, settings) : undefined;
  } catch (err) {
    log.warn('[chat-composer] Stored composer settings lookup failed:', err);
    return undefined;
  }
}
