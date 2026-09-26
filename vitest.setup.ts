/**
 * Vitest global setup.
 *
 * Without `--localstorage-file`, the built-in localStorage is unusable — the
 * global may be absent entirely or expose a stub whose `getItem` isn't a
 * function. Either way jotai's `atomWithStorage`, evaluated at module-load time,
 * throws. Install an in-memory shim whenever `getItem` isn't callable.
 */

import { cleanup } from '@testing-library/react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, vi } from 'vitest';

// Every test file gets its own absent Frink home (sc-2960, sc-2965): no suite can resolve the
// operator's ~/.frink, and no file sees another file's writes. Suites that fake a home pin
// FRINK_HOME to it; frink-custom-nodes-dir.ts reads its var at import, so it is set here too.
const testHome = mkdtempSync(join(tmpdir(), 'frink-test-home-'));
process.env.FRINK_HOME = testHome;
process.env.FRINK_CUSTOM_NODES_DIR = join(testHome, '.frink', 'nodes');
// Blank is the explicit local-only address: no suite can reach Frink's relay by leaving it unset.
process.env.FRINK_WEBHOOK_BASE_URL = '';
afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

// Tests must never write to the user's real app log (~/Library/Logs/frink). Mock the
// full surface source code touches: leveled methods plus transports.file (sync/level
// assignments and getFile().path reads). Per-file vi.mock('electron-log') still wins.
// Methods are plain noops (NOT vi.fn): tests spy via vi.spyOn(log, 'warn') and reset
// with restoreAllMocks — spyOn on a factory vi.fn would return that shared mock and
// leak call history across tests.
vi.mock('electron-log', () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      verbose: noop,
      silly: noop,
      transports: { file: { level: false, sync: false, getFile: () => ({ path: '' }) } },
    },
  };
});

// sentry/init statically imports @sentry/electron/main, whose internal `require('electron')`
// resolves the REAL CommonJS electron inside node_modules (per-file vi.mock('electron') does not
// reach into deps) and crashes module load for every suite whose graph touches a sentry-capturing
// module (tasks/stream-error-disposition, permissions/prompt-timeout, …). Same policy as
// electron-log above: global noop mock, per-file vi.mock('../sentry/init') still wins.
vi.mock('./src/main/lib/sentry/init', () => {
  const noop = () => {};
  return { initSentry: noop, captureMainException: noop, captureMainMessage: noop };
});

// Vitest defaults `globals: false`, so RTL’s side-effect `afterEach(cleanup)` in
// its main entry never registers; keep a single registration in setup.
afterEach(() => {
  cleanup();
});

if (typeof globalThis.localStorage?.getItem !== 'function') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  } as Storage;
}
