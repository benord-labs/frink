/**
 * Tests for the smoke modules-root resolver (scripts/smoke-native.cjs).
 *
 * Picking the wrong root false-greens a packaging break — an explicit override or a
 * stale empty env var must never silently redirect the smoke at dev node_modules
 * when it should test the packaged copy (or vice versa). The native load itself only
 * runs under Electron in CI; this is the one branch worth unit-pinning.
 */
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  checkCursorPlatform,
  cursorPlatformDir,
  packedEntry,
  packedModulesRoot,
  resolveModulesRoot,
} = require('./smoke-native.cjs');

describe('resolveModulesRoot', () => {
  it('honours an explicit FRINK_SMOKE_MODULES_ROOT override even when a packaged build exists', () => {
    expect(resolveModulesRoot({ FRINK_SMOKE_MODULES_ROOT: 'node_modules' }, true)).toBe(
      resolve('node_modules'),
    );
  });

  it('resolves a relative override to an absolute path', () => {
    const root = resolveModulesRoot({ FRINK_SMOKE_MODULES_ROOT: 'some/rel/dir' }, false);
    expect(isAbsolute(root)).toBe(true);
    expect(root).toBe(resolve('some/rel/dir'));
  });

  it('ignores an empty override and falls through (FRINK_SMOKE_MODULES_ROOT= must not become cwd)', () => {
    expect(resolveModulesRoot({ FRINK_SMOKE_MODULES_ROOT: '' }, false)).toBe(
      resolve('node_modules'),
    );
  });

  it('prefers the packaged app.asar.unpacked copy when a package:win build exists', () => {
    const root = resolveModulesRoot({}, true);
    expect(root).toContain('win-unpacked');
    expect(root).toContain('app.asar.unpacked');
  });

  it('falls back to dev node_modules with no override and no packaged build', () => {
    expect(resolveModulesRoot({}, false)).toBe(resolve('node_modules'));
  });
});

describe('packedModulesRoot', () => {
  it('looks for plain JavaScript in app.asar beside the unpacked native modules', () => {
    expect(packedModulesRoot('/r/resources/app.asar.unpacked/node_modules')).toBe(
      '/r/resources/app.asar/node_modules',
    );
    expect(packedModulesRoot('/repo/node_modules')).toBe('/repo/node_modules');
  });
});

describe('packedEntry', () => {
  it('picks the ES module build the main process imports, not the CommonJS one', () => {
    const root = realpathSync('node_modules');
    expect(packedEntry(root, '@github/copilot-sdk')).toBe(
      join(root, '@github/copilot-sdk/dist/index.js'),
    );
    expect(packedEntry(root, '@agentclientprotocol/sdk')).toBe(
      join(root, '@agentclientprotocol/sdk/dist/acp.js'),
    );
  });
});

describe('cursorPlatformDir', () => {
  it('finds the platform package beside a packaged Linux or macOS app', () => {
    expect(
      cursorPlatformDir('/opt/Frink/resources/app.asar.unpacked/node_modules', 'linux', 'arm64'),
    ).toBe('/opt/Frink/resources/node_modules/@cursor/sdk-linux-arm64');
    const mac = '/A/Frink.app/Contents/Resources/app.asar.unpacked/node_modules';
    expect(cursorPlatformDir(mac, 'darwin', 'x64')).toBe(
      '/A/Frink.app/Contents/Resources/node_modules/@cursor/sdk-darwin-x64',
    );
  });

  it('skips Windows, which ships no Cursor, and a dev node_modules', () => {
    expect(
      cursorPlatformDir('/r/resources/app.asar.unpacked/node_modules', 'win32', 'x64'),
    ).toBeNull();
    expect(cursorPlatformDir('/repo/node_modules', 'linux', 'x64')).toBeNull();
  });
});

const installedCursor = resolve('node_modules/@cursor', `sdk-${process.platform}-${process.arch}`);
const copies = [];

/** A temp copy of this machine's installed Cursor platform package holding only `parts`. */
function partialCopy(parts) {
  const copy = mkdtempSync(join(tmpdir(), 'frink-smoke-cursor-'));
  copies.push(copy);
  for (const part of parts)
    cpSync(join(installedCursor, part), join(copy, part), { recursive: true });
  return copy;
}

describe('checkCursorPlatform', () => {
  afterEach(() => {
    for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true });
  });

  it('accepts the installed platform package and loads both shell parsers', () => {
    expect(() => checkCursorPlatform(installedCursor)).not.toThrow();
  });

  it('needs only rg, since Frink never starts cursorsandbox', () => {
    expect(() => checkCursorPlatform(partialCopy(['bin/rg', 'vendor']))).not.toThrow();
  });

  it('fails without rg or a loadable shell parser', () => {
    expect(() => checkCursorPlatform(partialCopy(['vendor']))).toThrow(/no rg/);
    expect(() => checkCursorPlatform(partialCopy(['bin/rg', 'vendor/tree-sitter']))).toThrow(
      /tree-sitter-bash/,
    );
  });
});

describe('smoke-linux-launch.sh', () => {
  // The PostHog CI cohort is a fixed list from before this opt-out; a smoke launch that sends again counts as a real install.
  it('launches every packaged build with usage analytics off', () => {
    const script = readFileSync(new URL('./smoke-linux-launch.sh', import.meta.url), 'utf8');
    const launches = script
      .split('\n')
      .filter((line) => /\bsetsid\b/.test(line) && !line.trimStart().startsWith('#'));
    expect(launches).not.toHaveLength(0);
    for (const line of launches) expect(line).toContain('FRINK_DISABLE_USAGE_ANALYTICS=1');
  });
});
