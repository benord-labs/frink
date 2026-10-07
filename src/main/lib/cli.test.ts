import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLaunchDirectory, parseLaunchDirectory } from './cli';

describe('launch directory', () => {
  const originalArgv = process.argv;
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frink-cli-'));
    file = join(dir, 'notes.txt');
    writeFileSync(file, '');
    getLaunchDirectory(); // drain anything a previous test left behind
  });

  afterEach(() => {
    process.argv = originalArgv;
    rmSync(dir, { recursive: true, force: true });
  });

  // Packaged layout: argv[0] is the executable, everything after is user input.
  const launchWith = (...args: string[]) => {
    process.argv = ['/opt/Frink/frink', ...args];
    parseLaunchDirectory();
  };

  it('picks up a directory argument and hands it over exactly once', () => {
    launchWith(dir);
    expect(getLaunchDirectory()).toBe(dir);
    expect(getLaunchDirectory()).toBeNull();
  });

  it('skips flags, protocol URLs, files and missing paths before the directory', () => {
    launchWith('--no-sandbox', 'frink://auth?code=1', file, join(dir, 'missing'), dir);
    expect(getLaunchDirectory()).toBe(dir);
  });

  it('yields null when no argument is a directory', () => {
    launchWith('--no-sandbox', file);
    expect(getLaunchDirectory()).toBeNull();
  });
});
