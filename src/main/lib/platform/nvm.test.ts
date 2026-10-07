import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedNvmBinDirs, warmNvmBinDirs } from './nvm';

const homes: string[] = [];

function makeHome(versions: string[], aliases: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'frink-nvm-'));
  homes.push(home);
  for (const version of versions) {
    mkdirSync(join(home, '.nvm', 'versions', 'node', version, 'bin'), { recursive: true });
  }
  for (const [name, target] of Object.entries(aliases)) {
    const file = join(home, '.nvm', 'alias', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${target}\n`);
  }
  return home;
}

const binOf = (home: string, version: string) =>
  join(home, '.nvm', 'versions', 'node', version, 'bin');

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('resolveNvmBinDirs (sc-4724)', () => {
  it('returns nothing when nvm is not installed', async () => {
    expect(await warmNvmBinDirs(makeHome([]))).toEqual([]);
  });

  it('picks the newest installed version by semver when there is no default alias', async () => {
    // v9 sorts after v22 as a string; it must not win.
    const home = makeHome(['v9.11.2', 'v22.20.0', 'v22.3.0', 'v18.19.1']);
    expect(await warmNvmBinDirs(home)).toEqual([binOf(home, 'v22.20.0')]);
  });

  it('follows an exact default alias', async () => {
    const home = makeHome(['v18.19.1', 'v22.20.0'], { default: 'v18.19.1' });
    expect(await warmNvmBinDirs(home)).toEqual([binOf(home, 'v18.19.1')]);
  });

  it('resolves a partial default alias to the newest matching install', async () => {
    const home = makeHome(['v18.19.1', 'v18.20.4', 'v22.20.0', 'v2.0.0'], { default: '18' });
    expect(await warmNvmBinDirs(home)).toEqual([binOf(home, 'v18.20.4')]);
  });

  it('matches a partial alias on whole version components only ("2" is not v22)', async () => {
    const home = makeHome(['v2.0.0', 'v22.20.0'], { default: '2' });
    expect(await warmNvmBinDirs(home)).toEqual([binOf(home, 'v2.0.0')]);
  });

  it('follows a chained lts alias', async () => {
    const home = makeHome(['v20.18.0', 'v22.20.0', 'v24.1.0'], {
      default: 'lts/*',
      'lts/*': 'lts/jod',
      'lts/jod': 'v22.20.0',
    });
    expect(await warmNvmBinDirs(home)).toEqual([binOf(home, 'v22.20.0')]);
  });

  it('falls back to the newest install when the default alias names nothing installed', async () => {
    const home = makeHome(['v20.18.0', 'v22.20.0'], { default: 'system' });
    expect(await warmNvmBinDirs(home)).toEqual([binOf(home, 'v22.20.0')]);
  });

  it('follows an alias chain of any length, and stops at a cycle', async () => {
    const chained = makeHome(['v18.19.1', 'v22.20.0'], {
      default: 'a',
      a: 'b',
      b: 'c',
      c: 'd',
      d: 'e',
      e: 'f',
      f: 'v18.19.1',
    });
    expect(await warmNvmBinDirs(chained)).toEqual([binOf(chained, 'v18.19.1')]);

    const looped = makeHome(['v20.18.0', 'v22.20.0'], { default: 'a', a: 'b', b: 'a' });
    expect(await warmNvmBinDirs(looped)).toEqual([binOf(looped, 'v22.20.0')]);
  });

  it('serves the warmed dir from memory, and nothing before warming', async () => {
    // PATH config is built on request paths (Claude spawns); it must never touch the disk.
    const home = makeHome(['v20.18.0']);
    expect(cachedNvmBinDirs(home)).toEqual([]);

    await warmNvmBinDirs(home);
    mkdirSync(binOf(home, 'v22.20.0'), { recursive: true });

    expect(cachedNvmBinDirs(home)).toEqual([binOf(home, 'v20.18.0')]);
  });
});
