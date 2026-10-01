import type { WritableAtom } from 'jotai';
import { atom } from 'jotai';
import { atomFamily, atomWithStorage } from 'jotai/utils';
import { appStore } from '../jotai-store';
import { type ComposerField, persistComposerChat } from './composer-persistence';

/**
 * A per-key map atom created by the factories below. The per-key atoms handed out by
 * `mapAtomFamily` are stateless indexers — the value lives here, so this is what a
 * cleanup has to write to.
 */
type ChatScopedMapAtom = WritableAtom<Record<string, unknown>, [Record<string, unknown>], void>;

/** Every map atom created by `mapAtomFamily`, persisted and runtime alike. */
const chatScopedMapAtoms = new Set<ChatScopedMapAtom>();

/** Families whose value lives in the per-key atom, so `remove()` genuinely frees it. */
const chatScopedFamilies = new Set<{ remove: (key: string) => void }>();

/**
 * Opt a raw `atomFamily` into per-chat cleanup. Wrap the declaration in place:
 *
 * @example
 * export const fooAtomFamily = registerChatScopedFamily(atomFamily((_chatId: string) => atom(null)));
 *
 * Only for families whose state lives in the per-key atom. Families built by
 * `createPersistedAtomFamily` / `createRuntimeAtomFamily` register themselves.
 *
 * Import this from the module directly rather than the `lib/atoms` barrel — the barrel
 * re-exports `features/agents/atoms`, so going through it pulls a feature into a lib module.
 */
export function registerChatScopedFamily<F extends { remove: (key: string) => void }>(
  family: F,
): F {
  chatScopedFamilies.add(family);
  return family;
}

/** Per-chat state held outside jotai (e.g. zustand stores) that must be dropped with the chat. */
const chatScopedCleanups = new Set<(chatId: string) => void>();

/**
 * Opt state that does not live in a jotai atom into `cleanupChatScopedState`. The owning module
 * registers itself, so this lib module never imports a feature.
 */
export function registerChatScopedCleanup(cleanup: (chatId: string) => void): void {
  chatScopedCleanups.add(cleanup);
}

/**
 * Drop all per-chat state for `chatId`. Call when a chat is archived or permanently
 * deleted, after the chat has been deselected — a component still mounted on that id
 * re-creates its entry on the next render.
 *
 * Writing the map atom through `appStore` is what makes this stick: for a persisted
 * family the write also updates localStorage, so memory and storage stay in agreement.
 * Editing localStorage directly would not, because a same-document write fires no
 * storage event and the in-memory map would re-persist the deleted key on its next write.
 *
 * Keys that belong to another id space (e.g. sub-chat ids) simply never match.
 */
export function cleanupChatScopedState(chatId: string): void {
  for (const mapAtom of chatScopedMapAtoms) {
    const current = appStore.get(mapAtom);
    if (!Object.hasOwn(current, chatId)) continue;
    const { [chatId]: _removed, ...rest } = current;
    appStore.set(mapAtom, rest);
  }
  for (const family of chatScopedFamilies) {
    family.remove(chatId);
  }
  for (const cleanup of chatScopedCleanups) {
    cleanup(chatId);
  }
}

/**
 * Internal helper: wraps any writable map atom into an atomFamily
 * where each key gets its own read/write atom indexing into the map.
 */
function mapAtomFamily<T>(
  mapAtom: WritableAtom<Record<string, T>, [Record<string, T>], void>,
  defaultValue: T,
) {
  chatScopedMapAtoms.add(mapAtom as unknown as ChatScopedMapAtom);
  return atomFamily((key: string) =>
    atom(
      // `Object.hasOwn` rather than a bare index: the map is a plain object, so a key
      // like `toString` would otherwise resolve to Object.prototype's member — never
      // nullish, so `?? defaultValue` would not catch it — and hand back a Function.
      (get) => {
        const current = get(mapAtom);
        return Object.hasOwn(current, key) ? (current[key] ?? defaultValue) : defaultValue;
      },
      (get, set, value: T) => {
        const current = get(mapAtom);
        // Identical-value writes must not allocate a new map: atomWithStorage re-serializes the
        // WHOLE per-chat map to localStorage on every map identity change, so an echoed no-op
        // (e.g. the sub-chat mode round-trip) would rewrite storage once per echo.
        if (Object.hasOwn(current, key) && Object.is(current[key], value)) return;
        set(mapAtom, { ...current, [key]: value });
      },
    ),
  );
}

/**
 * Creates a persisted atomFamily backed by a single `atomWithStorage` map.
 *
 * Each key gets its own read/write atom that indexes into the shared storage map.
 * Values are persisted to localStorage via Jotai's atomWithStorage.
 *
 * @example
 * export const chatModeAtomFamily = createPersistedAtomFamily('agents:chatMode:perChat', 'agent');
 * // Usage: const [chatMode, setChatMode] = useAtom(chatModeAtomFamily('chat-123'));
 */
export function createPersistedAtomFamily<T>(storageKey: string, defaultValue: T) {
  const storageAtom = atomWithStorage<Record<string, T>>(storageKey, {}, undefined, {
    getOnInit: true,
  });
  return mapAtomFamily(storageAtom, defaultValue);
}

/**
 * Creates a runtime-only atomFamily backed by a plain atom map (not persisted).
 *
 * Same pattern as `createPersistedAtomFamily` but data is lost on page reload.
 * Use for ephemeral per-key state that doesn't need persistence.
 *
 * @example
 * export const expandedWidgetAtomFamily = createRuntimeAtomFamily<WidgetId | null>(null);
 */
export function createRuntimeAtomFamily<T>(defaultValue: T) {
  return mapAtomFamily(atom<Record<string, T>>({}), defaultValue);
}

/** The cache map behind each main-backed composer field, for echoes and hydration to write. */
const composerCacheMaps = new Map<
  ComposerField,
  WritableAtom<Record<string, unknown>, [Record<string, unknown>], void>
>();

/** A per-chat composer setting main owns, read from a persisted cache. User writes update it
 *  optimistically and go to main; echoes use `writeComposerCache`, which never writes back. */
export function createMainBackedAtomFamily<T>(
  storageKey: string,
  defaultValue: T,
  field: ComposerField,
) {
  const storageAtom = atomWithStorage<Record<string, T>>(storageKey, {}, undefined, {
    getOnInit: true,
  });
  composerCacheMaps.set(
    field,
    storageAtom as unknown as WritableAtom<
      Record<string, unknown>,
      [Record<string, unknown>],
      void
    >,
  );
  const cache = mapAtomFamily(storageAtom, defaultValue);
  return registerChatScopedFamily(
    atomFamily((key: string) =>
      atom(
        (get) => get(cache(key)),
        (get, set, value: T) => {
          if (Object.is(get(cache(key)), value)) return;
          set(cache(key), value);
          persistComposerChat(key, { [field]: value });
        },
      ),
    ),
  );
}

/** Mirror main's confirmed values into this window's cache without writing them back. */
export function writeComposerCache(
  chatId: string,
  values: Partial<Record<ComposerField, unknown>>,
): void {
  for (const [field, value] of Object.entries(values) as Array<[ComposerField, unknown]>) {
    const mapAtom = composerCacheMaps.get(field);
    if (!mapAtom || value === undefined) continue;
    const current = appStore.get(mapAtom);
    if (Object.hasOwn(current, chatId) && Object.is(current[chatId], value)) continue;
    appStore.set(mapAtom, { ...current, [chatId]: value });
  }
}

/** This window's cached per-chat values by field (the one-time import reads these). */
export function readComposerCacheMaps(): Partial<Record<ComposerField, Record<string, unknown>>> {
  return Object.fromEntries(
    [...composerCacheMaps].map(([field, mapAtom]) => [field, appStore.get(mapAtom)]),
  );
}
