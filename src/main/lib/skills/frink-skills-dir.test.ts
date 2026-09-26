import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFrinkSkillsDir, getSkillReadRoots, getUniversalSkillDirs } from '../frink-skills-dir';

describe('skill directories follow the home Frink owns', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps the canonical store and its per-tool projections in one home', () => {
    vi.stubEnv('FRINK_HOME', '/rig/home');
    expect(getFrinkSkillsDir()).toBe(join('/rig/home', '.frink', 'skills'));
    // Real copies Frink writes — a `.frink`-only override would leave these on the operator's dirs.
    expect(getUniversalSkillDirs()).toEqual([
      join('/rig/home', '.agents', 'skills'),
      join('/rig/home', '.claude', 'skills'),
      join('/rig/home', '.cursor', 'skills'),
    ]);
    expect(getSkillReadRoots()).toEqual([getFrinkSkillsDir(), ...getUniversalSkillDirs()]);
  });

  it('uses the real home when no isolated home is configured', () => {
    vi.stubEnv('FRINK_HOME', undefined);
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/operator');
    expect(getFrinkSkillsDir()).toBe(join('/Users/operator', '.frink', 'skills'));
  });
});
