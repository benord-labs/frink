// sc-4357: sibling-package deps must be installed for every vitest run, including runs that skip the
// npm pre-hooks (devkit coverage-run, IDE runners), and the probe must not be fooled by root hoisting.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vitestConfig from '../../vitest.config';
import {
  breakAbandonedLock,
  ensurePackageDeps,
  findMissingDeps,
  isCliEntry,
  SIBLING_PACKAGES,
} from './ensure-package-deps.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

let root;
let lockPath;

function writePackage(dir, dependencies) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies }));
}

function installDep(nodeModulesParent, name) {
  writePackage(join(nodeModulesParent, 'node_modules', name), {});
}

function run(overrides = {}) {
  const install = vi.fn((pkgDir) => installDep(pkgDir, 'helmet'));
  const log = vi.fn();
  ensurePackageDeps({
    root,
    packages: ['pkg'],
    install,
    log,
    lockPathFor: () => lockPath,
    sleep: () => {
      throw new Error('unexpected wait');
    },
    ...overrides,
  });
  return { install, log };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ensure-deps-test-'));
  lockPath = join(root, 'pkg.lock');
  writePackage(join(root, 'pkg'), { helmet: '^8.0.0' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ensurePackageDeps', () => {
  it('installs a package with no node_modules and names it', () => {
    const { install, log } = run();
    expect(install).toHaveBeenCalledExactlyOnceWith(join(root, 'pkg'));
    expect(log.mock.calls[0][0]).toContain('installing pkg (unresolved: helmet)');
  });

  it('skips a package whose deps are installed in its own node_modules', () => {
    installDep(join(root, 'pkg'), 'helmet');
    expect(run().install).not.toHaveBeenCalled();
  });

  it('treats a dep hoisted only into the root node_modules as missing', () => {
    installDep(root, 'helmet');
    expect(findMissingDeps(join(root, 'pkg'))).toEqual(['helmet']);
    expect(run().install).toHaveBeenCalledOnce();
  });

  it('waits on a held lock and skips the install the holder already did', () => {
    mkdirSync(lockPath);
    const sleep = vi.fn(() => {
      installDep(join(root, 'pkg'), 'helmet');
      rmSync(lockPath, { recursive: true });
    });
    const { install } = run({ sleep });
    expect(sleep).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
  });

  it('breaks a stale lock left by a killed run, then installs and releases it', () => {
    mkdirSync(lockPath);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(lockPath, old, old);
    const { install } = run();
    expect(install).toHaveBeenCalledOnce();
    expect(() => mkdirSync(lockPath)).not.toThrow();
  });

  it('releases the lock when the install fails', () => {
    expect(() =>
      run({
        install: () => {
          throw new Error('npm ci failed');
        },
      }),
    ).toThrow('npm ci failed');
    expect(() => mkdirSync(lockPath)).not.toThrow();
  });
});

describe('ensurePackageDeps edge cases', () => {
  // relay's suite imports socket.io-client, a devDependency. `npm ci` under NODE_ENV=production
  // leaves devDependencies out, and a dependencies-only probe would read that tree as installed.
  it('installs when only a (scoped) devDependency is missing', () => {
    writeFileSync(
      join(root, 'pkg', 'package.json'),
      JSON.stringify({ dependencies: { helmet: '1' }, devDependencies: { '@scope/client': '1' } }),
    );
    installDep(join(root, 'pkg'), 'helmet');
    const { install, log } = run();
    expect(install).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('unresolved: @scope/client');
  });

  // A run killed mid-install (devkit kills coverage runs) leaves its lock behind. Without a liveness
  // check the next run would sit out the full stale window before installing.
  it('breaks a fresh lock whose holder process is dead without waiting', () => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'pid'), String(pid));
    expect(run().install).toHaveBeenCalledOnce();
  });

  // The holder's pid file is briefly empty between writeFileSync's truncate and its write; reading
  // that as "dead holder" would break a live lock and run two `npm ci` at once.
  it('waits on a fresh lock whose pid file is still empty', () => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'pid'), '');
    const sleep = vi.fn(() => {
      installDep(join(root, 'pkg'), 'helmet');
      rmSync(lockPath, { recursive: true });
    });
    expect(run({ sleep }).install).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('records its own pid in the lock while installing', () => {
    let recorded;
    run({ install: () => (recorded = readFileSync(join(lockPath, 'pid'), 'utf8')) });
    expect(recorded).toBe(String(process.pid));
  });

  // As a globalSetup, a failed install (offline, npm missing, lock out of sync) must not take down
  // every unrelated suite in the run; it warns, naming the package, and moves on.
  it('in non-strict mode warns and continues past a failed install, releasing its lock', () => {
    writePackage(join(root, 'other'), { zod: '1' });
    const installed = [];
    const { log } = run({
      packages: ['pkg', 'other'],
      strict: false,
      install: (pkgDir) => {
        if (pkgDir.endsWith('pkg')) throw new Error('getaddrinfo ENOTFOUND');
        installed.push(pkgDir);
      },
    });
    expect(installed).toEqual([join(root, 'other')]);
    expect(log.mock.calls.some(([line]) => /pkg.*ENOTFOUND/s.test(line))).toBe(true);
    expect(() => mkdirSync(lockPath)).not.toThrow();
  });
});

// Breaking an abandoned lock is check-then-act: waiters A and B can both judge a dead holder's lock
// abandoned, A breaks it and takes a fresh one, then B's late break would delete A's LIVE lock and
// both would run `npm ci` on one node_modules. Breaks re-verify under a breaker lock.
describe('breakAbandonedLock', () => {
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

  function lockOwnedBy(pid) {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'pid'), String(pid));
  }

  it('leaves a lock a live process re-acquired after the caller judged it abandoned', () => {
    lockOwnedBy(process.ppid);
    expect(breakAbandonedLock(lockPath)).toBe(false);
    expect(readFileSync(join(lockPath, 'pid'), 'utf8')).toBe(String(process.ppid));
  });

  it('removes a dead holder lock and leaves no breaker behind', () => {
    lockOwnedBy(deadPid());
    expect(breakAbandonedLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.break`)).toBe(false);
  });

  it('defers to a concurrent breaker instead of racing it', () => {
    lockOwnedBy(deadPid());
    mkdirSync(`${lockPath}.break`);
    expect(breakAbandonedLock(lockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('clears a breaker left by a run killed mid-break, so the lock can still be broken', () => {
    lockOwnedBy(deadPid());
    mkdirSync(`${lockPath}.break`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lockPath}.break`, old, old);
    expect(breakAbandonedLock(lockPath)).toBe(false);
    expect(breakAbandonedLock(lockPath)).toBe(true);
  });

  it('never releases a lock another process holds by the time the install finishes', () => {
    run({
      install: () => {
        rmSync(lockPath, { recursive: true });
        lockOwnedBy(process.ppid);
      },
    });
    expect(readFileSync(join(lockPath, 'pid'), 'utf8')).toBe(String(process.ppid));
  });
});

describe.skipIf(process.platform === 'win32')('default npm installer', () => {
  // The main frink-oss checkout lives under a path with spaces, and IDE runners start vitest from
  // other cwds: the prefix must be absolute and quoted. --include=dev overrides NODE_ENV=production.
  it('runs npm ci with an absolute quoted prefix that includes devDependencies', () => {
    const spaced = join(root, 'with space');
    writePackage(join(spaced, 'pkg'), { helmet: '1' });
    const bin = join(root, 'bin');
    const argsFile = join(root, 'npm-args');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, {
      mode: 0o755,
    });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    try {
      ensurePackageDeps({ root: spaced, packages: ['pkg'], log: () => {} });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      'ci',
      '--include=dev',
      '--prefix',
      join(spaced, 'pkg'),
    ]);
  });
});

describe('isCliEntry', () => {
  // Node runs the main module from its realpath, so an argv[1] reached through a symlinked path
  // must still count, or the pre* hooks would silently skip the install.
  it.skipIf(process.platform === 'win32')('accepts a symlinked path to this script', () => {
    const script = resolve(import.meta.dirname, 'ensure-package-deps.mjs');
    const link = join(root, 'link.mjs');
    symlinkSync(script, link);
    expect(isCliEntry(link, pathToFileURL(script).href)).toBe(true);
  });

  it('rejects another entry point and a missing argv[1]', () => {
    const url = pathToFileURL(resolve(import.meta.dirname, 'ensure-package-deps.mjs')).href;
    expect(isCliEntry(resolve(ROOT, 'vitest.config.ts'), url)).toBe(false);
    expect(isCliEntry(undefined, url)).toBe(false);
  });
});

describe('vitest wiring', () => {
  it('runs the gate as a globalSetup, so runs that skip npm pre-hooks still install', () => {
    expect(vitestConfig.test.globalSetup).toContain('./scripts/dev/ensure-package-deps.mjs');
  });

  it('covers every top-level package the root vitest config collects tests from', () => {
    const collected = [...new Set(vitestConfig.test.include.map((glob) => glob.split('/')[0]))];
    const packages = collected.filter((dir) => existsSync(join(ROOT, dir, 'package.json')));
    expect(packages.sort()).toEqual([...SIBLING_PACKAGES].sort());
  });
});
