/**
 * Tests for the smoke modules-root resolver (scripts/smoke-native.cjs).
 *
 * Picking the wrong root false-greens a packaging break — an explicit override or a
 * stale empty env var must never silently redirect the smoke at dev node_modules
 * when it should test the packaged copy (or vice versa). The native load itself only
 * runs under Electron in CI; this is the one branch worth unit-pinning.
 */
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveModulesRoot } = require('./smoke-native.cjs');

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
