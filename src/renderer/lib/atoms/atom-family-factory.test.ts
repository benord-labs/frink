// @vitest-environment happy-dom
// Needed for the persistence cases: jotai's default JSON storage resolves
// `window.localStorage`, which does not exist under the default node environment.
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../jotai-store';
import {
  cleanupChatScopedState,
  createPersistedAtomFamily,
  createRuntimeAtomFamily,
  registerChatScopedFamily,
} from './atom-family-factory';

/**
 * These tests read state back through `family(chatId)` rather than inspecting the
 * family's internal key set. That distinction is the point: a cleanup that only calls
 * `atomFamily.remove()` drops the cached per-key atom while leaving the value in the
 * shared map, so a key-set assertion would pass while the value survives.
 */

// A unique storage key per test run keeps the module-level registries, which persist
// across tests by design, from letting one case observe another's leftovers.
let seq = 0;
function nextStorageKey(): string {
  seq += 1;
  return `test:atom-family-factory:${seq}`;
}

describe('persisted family identical-value writes', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // An echoed no-op write (e.g. the sub-chat mode round-trip re-delivering the current mode)
  // must not allocate a new map: that rewrites the whole per-chat map to localStorage and
  // re-notifies every subscriber of every key in the family.
  it('is a no-op — subscribers do not fire and the map identity is unchanged', () => {
    const family = createPersistedAtomFamily<string>(nextStorageKey(), 'default');
    appStore.set(family('chat-a'), 'plan');
    const listener = vi.fn();
    const unsub = appStore.sub(family('chat-a'), listener);

    appStore.set(family('chat-a'), 'plan');

    expect(listener).not.toHaveBeenCalled();
    expect(appStore.get(family('chat-a'))).toBe('plan');
    unsub();
  });
});

describe('cleanupChatScopedState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('drops the value from a persisted family, not just the cached atom', () => {
    const family = createPersistedAtomFamily<string>(nextStorageKey(), 'default');
    appStore.set(family('chat-a'), 'a-value');
    appStore.set(family('chat-b'), 'b-value');

    cleanupChatScopedState('chat-a');

    expect(appStore.get(family('chat-a'))).toBe('default');
    expect(appStore.get(family('chat-b'))).toBe('b-value');
  });

  it('drops the value from a runtime family, which no cleanup previously reached', () => {
    const family = createRuntimeAtomFamily<number>(0);
    appStore.set(family('chat-a'), 42);
    appStore.set(family('chat-b'), 7);

    cleanupChatScopedState('chat-a');

    expect(appStore.get(family('chat-a'))).toBe(0);
    expect(appStore.get(family('chat-b'))).toBe(7);
  });

  it('does not re-persist a removed key when a mounted family is written again', () => {
    const storageKey = nextStorageKey();
    const family = createPersistedAtomFamily<string>(storageKey, 'default');

    // Hold the subscription open across the cleanup. A family that fully unmounts
    // re-reads storage on remount, which would mask a stale in-memory map and let
    // this test pass without exercising the regression.
    const unsub = appStore.sub(family('chat-b'), () => {});

    appStore.set(family('chat-a'), 'a-value');
    appStore.set(family('chat-b'), 'b-value');

    cleanupChatScopedState('chat-a');

    // A later write to a different chat re-serialises the whole map.
    appStore.set(family('chat-b'), 'b-value-2');

    const persisted = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    expect(persisted).toEqual({ 'chat-b': 'b-value-2' });

    unsub();
  });

  it('keeps memory and storage in agreement after every subscriber unmounts', () => {
    const storageKey = nextStorageKey();
    const family = createPersistedAtomFamily<string>(storageKey, 'default');

    const unsub = appStore.sub(family('chat-a'), () => {});
    appStore.set(family('chat-a'), 'a-value');

    cleanupChatScopedState('chat-a');
    unsub();

    // Remounting re-reads storage, so a fix that repaired memory but left storage
    // dirty would resurrect the value here.
    const unsubAgain = appStore.sub(family('chat-a'), () => {});
    expect(appStore.get(family('chat-a'))).toBe('default');
    expect(JSON.parse(localStorage.getItem(storageKey) ?? '{}')).toEqual({});
    unsubAgain();
  });

  it('removes the entry from a registered raw family', () => {
    const family = registerChatScopedFamily(
      atomFamily((_chatId: string) => atom<string | null>(null)),
    );
    appStore.set(family('chat-a'), 'selection');
    appStore.set(family('chat-b'), 'other-selection');

    cleanupChatScopedState('chat-a');

    expect(appStore.get(family('chat-a'))).toBeNull();
    expect(appStore.get(family('chat-b'))).toBe('other-selection');
  });

  it('leaves keys from other id spaces untouched', () => {
    // The new-chat pane and sub-chats key the same families with ids that are never
    // chat ids, so a chat-scoped sweep must never match them.
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('__new__'), 'draft-selection');
    appStore.set(family('sub-chat-1'), 'sub-value');
    appStore.set(family('chat-a'), 'a-value');

    cleanupChatScopedState('chat-a');

    expect(appStore.get(family('__new__'))).toBe('draft-selection');
    expect(appStore.get(family('sub-chat-1'))).toBe('sub-value');
  });

  it('is a no-op for a chat that has no state', () => {
    const storageKey = nextStorageKey();
    const family = createPersistedAtomFamily<string>(storageKey, 'default');
    appStore.set(family('chat-a'), 'a-value');
    const before = localStorage.getItem(storageKey);

    cleanupChatScopedState('chat-never-seen');

    expect(localStorage.getItem(storageKey)).toBe(before);
    expect(appStore.get(family('chat-a'))).toBe('a-value');
  });

  it.each(['__proto__', 'constructor', 'toString', 'valueOf'])(
    'leaves other chats intact when cleaning up %s',
    (inheritedKey) => {
      const family = createRuntimeAtomFamily<string>('default');
      appStore.set(family('chat-a'), 'a-value');

      cleanupChatScopedState(inheritedKey);

      expect(appStore.get(family('chat-a'))).toBe('a-value');
    },
  );

  it.each(['toString', 'constructor', 'valueOf'])(
    'returns the default, not the inherited member, for unset key %s',
    (inheritedKey) => {
      // The backing map is a plain object, so a bare `map[key] ?? defaultValue` hands back
      // Object.prototype's member for these keys — a Function where callers expect T.
      // Unreachable for cuid2 chat ids, but these families are keyed by whatever a caller
      // passes, so the read must not depend on the id space to stay type-honest.
      const family = createRuntimeAtomFamily<string>('default');
      expect(appStore.get(family(inheritedKey))).toBe('default');
    },
  );

  it('removes an own entry whose key shadows an Object.prototype member', () => {
    // The mirror of the case above: a real own entry must still be removed.
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('toString'), 'shadowing-value');
    appStore.set(family('chat-a'), 'a-value');

    cleanupChatScopedState('toString');

    expect(appStore.get(family('toString'))).toBe('default');
    expect(appStore.get(family('chat-a'))).toBe('a-value');
  });

  it('keeps both removals when two chats are cleaned in sequence', () => {
    // Each cleanup is a read-modify-write of the same map. The second must build on the
    // first's result, not on a snapshot taken before it.
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('chat-a'), 'a-value');
    appStore.set(family('chat-b'), 'b-value');
    appStore.set(family('chat-c'), 'c-value');

    cleanupChatScopedState('chat-a');
    cleanupChatScopedState('chat-b');

    expect(appStore.get(family('chat-a'))).toBe('default');
    expect(appStore.get(family('chat-b'))).toBe('default');
    expect(appStore.get(family('chat-c'))).toBe('c-value');
  });

  it('serialises cleanups that interleave with awaits, as concurrent deletes do', async () => {
    // Two delete handlers in flight resume at arbitrary points. Cleanup itself is
    // synchronous, so the only ordering that matters is between whole cleanups.
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('chat-a'), 'a-value');
    appStore.set(family('chat-b'), 'b-value');

    await Promise.all([
      (async () => {
        await Promise.resolve();
        cleanupChatScopedState('chat-a');
      })(),
      (async () => {
        cleanupChatScopedState('chat-b');
      })(),
    ]);

    expect(appStore.get(family('chat-a'))).toBe('default');
    expect(appStore.get(family('chat-b'))).toBe('default');
  });

  it('serves the default to a subscriber that is still mounted on the removed chat', () => {
    // Cleanup runs after deselect, but React commits the unmount a microtask later, so a
    // mounted reader can outlive it briefly. Reading must degrade to the default rather
    // than throw or resurrect — that is what makes the residual window benign.
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('chat-a'), 'a-value');
    const unsub = appStore.sub(family('chat-a'), () => {});

    cleanupChatScopedState('chat-a');

    expect(appStore.get(family('chat-a'))).toBe('default');
    unsub();
  });
});

/**
 * Wiring: every test above builds its own family, so all of them would still pass if
 * the real declarations were never registered. These assert the production families
 * are actually reachable from the sweep.
 */
describe('cleanupChatScopedState covers the real per-chat families', () => {
  it('sweeps the code-editor families the sweep was introduced for', async () => {
    const {
      codeSelectionContextAtomFamily,
      chatContextFileAtomFamily,
      chatContextFileDismissedAtomFamily,
    } = await import('../code-editor/state/atoms');

    appStore.set(codeSelectionContextAtomFamily('chat-real'), {
      filePath: '/a.ts',
      content: 'x',
      selection: { startLine: 1, endLine: 2 },
    } as never);
    appStore.set(chatContextFileAtomFamily('chat-real'), { name: 'a.ts', path: '/a.ts' });
    appStore.set(chatContextFileDismissedAtomFamily('chat-real'), true);

    cleanupChatScopedState('chat-real');

    expect(appStore.get(codeSelectionContextAtomFamily('chat-real'))).toBeNull();
    expect(appStore.get(chatContextFileAtomFamily('chat-real'))).toBeNull();
    expect(appStore.get(chatContextFileDismissedAtomFamily('chat-real'))).toBe(false);
  });

  it('sweeps persisted per-chat preferences back to their declared defaults', async () => {
    // Both are keyed by parent chat id, unlike the sub-chat-keyed families that a
    // chat-scoped sweep deliberately does not reach.
    const { chatModeAtomFamily, autoModePerChatAtomFamily } =
      await import('../../features/agents/atoms');

    appStore.set(chatModeAtomFamily('chat-real-2'), 'plan');
    appStore.set(autoModePerChatAtomFamily('chat-real-2'), false);
    appStore.set(chatModeAtomFamily('chat-kept-2'), 'plan');

    cleanupChatScopedState('chat-real-2');

    expect(appStore.get(chatModeAtomFamily('chat-real-2'))).toBe('agent');
    expect(appStore.get(autoModePerChatAtomFamily('chat-real-2'))).toBe(true);
    expect(appStore.get(chatModeAtomFamily('chat-kept-2'))).toBe('plan');
  });
});
