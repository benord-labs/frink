import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRigHomeIsolated, frinkUserHome } from './frink-home';

describe('frinkUserHome', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('falls back to the real home when no isolated home is configured', () => {
    vi.stubEnv('FRINK_HOME', undefined);
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/operator');
    expect(frinkUserHome()).toBe('/Users/operator');
  });

  it('resolves per call, so a caller that repoints the home mid-process sees the new value', () => {
    vi.stubEnv('FRINK_HOME', '/rig/one');
    expect(frinkUserHome()).toBe('/rig/one');
    vi.stubEnv('FRINK_HOME', '/rig/two');
    expect(frinkUserHome()).toBe('/rig/two');
  });
});

describe('assertRigHomeIsolated', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(os.tmpdir(), 'frink-rig-home-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('stays silent for the operator app, which has no isolation to enforce', () => {
    vi.stubEnv('FRINK_CDP_PORT', undefined);
    vi.stubEnv('FRINK_HOME', undefined);
    expect(() => assertRigHomeIsolated()).not.toThrow();
  });

  it('accepts an isolated instance pointed at a directory of its own', () => {
    vi.stubEnv('FRINK_CDP_PORT', '9223');
    vi.stubEnv('FRINK_HOME', tempDir());
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/operator');
    expect(() => assertRigHomeIsolated()).not.toThrow();
  });

  it('refuses an isolated instance with no home of its own', () => {
    vi.stubEnv('FRINK_CDP_PORT', '9223');
    vi.stubEnv('FRINK_HOME', undefined);
    expect(() => assertRigHomeIsolated()).toThrow(/no FRINK_HOME/);
  });

  it('refuses a home that was never seeded, naming the seed step rather than an ENOENT', () => {
    vi.stubEnv('FRINK_CDP_PORT', '9223');
    vi.stubEnv('FRINK_HOME', join(tempDir(), 'never-created'));
    expect(() => assertRigHomeIsolated()).toThrow(/does not exist/);
  });

  it("refuses a home that names the operator's own under a different path spelling", () => {
    // One directory, two spellings — string equality alone would wave the aliased one through.
    const real = realpathSync.native(tempDir());
    const alias = join(tempDir(), 'home-link');
    symlinkSync(real, alias);
    vi.stubEnv('FRINK_CDP_PORT', '9223');
    vi.stubEnv('FRINK_HOME', alias);
    vi.spyOn(os, 'homedir').mockReturnValue(real);
    expect(() => assertRigHomeIsolated()).toThrow(/real home/);
  });

  it('treats a blank FRINK_HOME as no home at all, not as the process working directory', () => {
    vi.stubEnv('FRINK_CDP_PORT', '9223');
    vi.stubEnv('FRINK_HOME', '   ');
    expect(() => assertRigHomeIsolated()).toThrow(/no FRINK_HOME/);
    vi.stubEnv('FRINK_CDP_PORT', undefined);
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/operator');
    expect(frinkUserHome()).toBe('/Users/operator');
  });
});
