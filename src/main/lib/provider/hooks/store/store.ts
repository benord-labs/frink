import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import log from 'electron-log';
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';
import { frinkUserHome } from '../../../platform/frink-home';
import { captureMainException } from '../../../sentry/init';
import {
  type HookSettings,
  hookEventsSchema,
  loadedSettingsSchema,
  readHookSettings,
} from '../inventory';

const StoredHookSource = z.object({
  scope: z.enum(['user', 'project']),
  /** The main checkout a project source belongs to. */
  projectRoot: z.string().optional(),
  /** Fingerprint of the native file's hooks when they were last imported. */
  baseline: z.string(),
  importedAt: z.string(),
  // The shape a native settings file must have, so a hand-edited store cannot hold less.
  hooks: hookEventsSchema,
  disableAllHooks: z.boolean().optional(),
});
export type StoredHookSource = z.infer<typeof StoredHookSource>;

/** Frink's copy of the user's hooks, keyed by the native settings file each came from. */
const HookStore = z.object({
  version: z.literal(1),
  sources: z.record(z.string(), StoredHookSource),
});
export type HookStore = z.infer<typeof HookStore>;

type NativeSource = { file: string; scope: StoredHookSource['scope']; projectRoot?: string };

const storeMutex = new Mutex();

function hookStorePath(): string {
  return path.join(frinkUserHome(), '.frink', 'hooks', 'hooks.json');
}

async function readHookStore(): Promise<HookStore> {
  try {
    return HookStore.parse(JSON.parse(await fs.readFile(hookStorePath(), 'utf8')));
  } catch (error) {
    // SAFETY: fs rejects with an ErrnoException; a parse error has no `code`, which is not ENOENT.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('[hooks] Unreadable hook store, re-importing from the native files', error);
      captureMainException(error, { surface: 'hook-store-read' });
    }
    return { version: 1, sources: {} };
  }
}

function fingerprint({ hooks, disableAllHooks }: HookSettings): string {
  const hash = createHash('sha256').update(stableStringify({ hooks, disableAllHooks }));
  return hash.digest('hex');
}

/** The user's settings file, then a project's `settings.json` and `settings.local.json`. */
function nativeSources(projectRoot: string | null): NativeSource[] {
  const userFile = path.join(frinkUserHome(), '.claude', 'settings.json');
  const sources: NativeSource[] = [{ file: userFile, scope: 'user' }];
  if (!projectRoot) return sources;
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(projectRoot, '.claude', name);
    if (file !== userFile) sources.push({ file, scope: 'project', projectRoot });
  }
  return sources;
}

/** Brings one source up to date; true when the store changed. A file that cannot be read keeps
 * its last imported hooks, and an edit Frink made stands until the native file changes. */
async function syncSource(store: HookStore, source: NativeSource): Promise<boolean> {
  const read = await readHookSettings(source.file, loadedSettingsSchema);
  if (read.status === 'invalid') {
    log.warn(`[hooks] Keeping the stored hooks of an unreadable file: ${source.file}`);
    return false;
  }
  const settings = read.status === 'read' ? read.settings : {};
  if (!settings.hooks && settings.disableAllHooks === undefined) {
    if (!store.sources[source.file]) return false;
    delete store.sources[source.file];
    return true;
  }
  const baseline = fingerprint(settings);
  if (store.sources[source.file]?.baseline === baseline) return false;
  store.sources[source.file] = {
    ...source,
    baseline,
    importedAt: new Date().toISOString(),
    hooks: settings.hooks ?? {},
    ...(settings.disableAllHooks !== undefined && { disableAllHooks: settings.disableAllHooks }),
  };
  return true;
}

/** Saves the store whole or not at all. A failed save is logged: this launch still gets the hooks
 * it just read, and the next launch tries again. */
async function writeHookStore(store: HookStore): Promise<void> {
  const file = hookStorePath();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(store, null, 2), 'utf8');
    await fs.rename(temporary, file);
  } catch (error) {
    log.warn('[hooks] Could not save the hook store', error);
    captureMainException(error, { surface: 'hook-store-write' });
  }
}

/** Imports the user's hooks and a project's into `~/.frink/hooks`, pulling back native edits, and
 * returns the store. */
export async function syncHookStore(projectRoot: string | null): Promise<HookStore> {
  return storeMutex.runExclusive(async () => {
    const store = await readHookStore();
    let changed = false;
    for (const source of nativeSources(projectRoot)) {
      changed = (await syncSource(store, source)) || changed;
    }
    if (changed) await writeHookStore(store);
    return store;
  });
}
