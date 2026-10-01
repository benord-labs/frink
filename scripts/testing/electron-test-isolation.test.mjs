import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const SENTINEL = /node_modules[\\/]\.electron-test-sentinel$/;

/**
 * Guards the vitest.config.ts ELECTRON_OVERRIDE_DIST_PATH pin (sc-1452).
 *
 * electron (43+) has no install lifecycle script and fetches its ~120MB binary lazily inside
 * `module.exports = getElectronPath()`. Without this pin a test process that reaches the real
 * module downloads it mid-suite, or — on a checkout that never ran `dev` — fails with
 * "Electron failed to install correctly" across every suite whose graph touches electron.
 * Neither vi.mock('electron') nor resolve.alias can prevent that, because a dependency's internal
 * CJS require('electron') is externalized and resolved by Node.
 */
describe('electron test isolation', () => {
  it('pins ELECTRON_OVERRIDE_DIST_PATH to a sentinel that cannot resolve to a real binary', () => {
    // Truthiness alone would be vacuous: a shell-provided override pointing at a REAL dist would
    // satisfy it while proving nothing, and the download this guards against could still fire on a
    // machine that lacks that dist. Assert the config's own sentinel, and that nothing lives there.
    const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
    expect(override).toMatch(SENTINEL);
    expect(existsSync(override)).toBe(false);
  });

  it('resolves the real electron module without downloading or throwing', () => {
    // The unmocked, dependency-style route: plain CJS require, exactly what @sentry/electron/main
    // does internally. On an unpinned checkout with no binary this throws.
    const require = createRequire(import.meta.url);
    const electronPath = require('electron');

    // Semantics are unchanged from a machine that has the binary: still a path string, and it comes
    // from the sentinel rather than node_modules/electron/dist.
    expect(typeof electronPath).toBe('string');
    expect(electronPath).toContain(process.env.ELECTRON_OVERRIDE_DIST_PATH);
  });
});
