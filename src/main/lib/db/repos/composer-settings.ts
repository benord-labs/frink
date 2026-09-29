import { eq, isNotNull, or } from 'drizzle-orm';
import type { CodexSpeed } from '../../../../shared/types/execution';
import type { getDatabase } from '../index';
import { appPreferences, chats } from '../schema';

type Db = ReturnType<typeof getDatabase>;

/** A chat's stored composer values; `null` = never set (defaults resolve in shared code). */
export type StoredComposerSettings = {
  modelId: string | null;
  autoMode: boolean | null;
  codexSpeed: CodexSpeed | null;
};

export type ComposerSettingsPatch = Partial<{
  modelId: string;
  autoMode: boolean;
  codexSpeed: CodexSpeed;
}>;

const columns = {
  modelId: chats.composerModelId,
  autoMode: chats.composerAutoMode,
  codexSpeed: chats.composerCodexSpeed,
};

function toColumns(patch: ComposerSettingsPatch) {
  return {
    ...(patch.modelId !== undefined ? { composerModelId: patch.modelId } : {}),
    ...(patch.autoMode !== undefined ? { composerAutoMode: patch.autoMode } : {}),
    ...(patch.codexSpeed !== undefined ? { composerCodexSpeed: patch.codexSpeed } : {}),
  };
}

/** `null` when the chat does not exist. */
export function getChatComposerSettings(db: Db, chatId: string): StoredComposerSettings | null {
  return db.select(columns).from(chats).where(eq(chats.id, chatId)).get() ?? null;
}

/** Writes the given fields and returns the confirmed row; `null` when the chat does not exist. */
export function updateChatComposerSettings(
  db: Db,
  chatId: string,
  patch: ComposerSettingsPatch,
): StoredComposerSettings | null {
  const values = toColumns(patch);
  if (Object.keys(values).length > 0) {
    db.update(chats).set(values).where(eq(chats.id, chatId)).run();
  }
  return getChatComposerSettings(db, chatId);
}

/** The part of `patch` that lands on values still unset in `current`. */
function missingOnly(current: StoredComposerSettings, patch: ComposerSettingsPatch) {
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([field, value]) =>
        value !== undefined && current[field as keyof StoredComposerSettings] === null,
    ),
  ) as ComposerSettingsPatch;
}

/** Fills only NULL values, so the one-time localStorage import never overwrites a choice made
 *  elsewhere. Skips unknown chats; returns the chats whose row changed. */
export function fillMissingComposerSettings(
  db: Db,
  entries: Array<{ chatId: string } & ComposerSettingsPatch>,
): Array<{ chatId: string; settings: StoredComposerSettings }> {
  return db.transaction(() =>
    entries.flatMap(({ chatId, ...patch }) => {
      const current = getChatComposerSettings(db, chatId);
      const missing = current ? missingOnly(current, patch) : {};
      if (Object.keys(missing).length === 0) return [];
      const settings = updateChatComposerSettings(db, chatId, missing);
      return settings ? [{ chatId, settings }] : [];
    }),
  );
}

/** Every chat with at least one stored composer value (boot hydration for a window). */
export function listStoredComposerSettings(
  db: Db,
): Array<{ chatId: string } & StoredComposerSettings> {
  return db
    .select({ chatId: chats.id, ...columns })
    .from(chats)
    .where(
      or(
        isNotNull(chats.composerModelId),
        isNotNull(chats.composerAutoMode),
        isNotNull(chats.composerCodexSpeed),
      ),
    )
    .all();
}

/** A JSON preference, or `undefined` when unset or unreadable. */
export function getPreference<T>(db: Db, key: string): T | undefined {
  const row = db
    .select({ value: appPreferences.value })
    .from(appPreferences)
    .where(eq(appPreferences.key, key))
    .get();
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

export function setPreference(db: Db, key: string, value: unknown): void {
  const now = new Date();
  const json = JSON.stringify(value);
  db.insert(appPreferences)
    .values({ key, value: json, updatedAt: now })
    .onConflictDoUpdate({ target: appPreferences.key, set: { value: json, updatedAt: now } })
    .run();
}
