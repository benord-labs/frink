#!/usr/bin/env node
/**
 * Test-time gate: the root vitest config collects the sibling packages listed below, but each is
 * an independently deployed package carrying its own npm lockfile that a root `bun install` never
 * touches. Every clean checkout — a git worktree, a fresh clone, a CI runner — therefore reaches
 * those suites with the dependencies absent and fails at import.
 *
 * It belongs at test time and not in the root `postinstall`: the dependency is on RUNNING the
 * tests, and `npm ci` wipes and rebuilds node_modules, so installing at postinstall would charge
 * every root `bun install` a full sibling reinstall and let a sibling lockfile problem fail the
 * root install outright.
 *
 * Two entry points (sc-4357): the `pre*` npm hooks run it as a CLI, and vitest loads it as a
 * `globalSetup`. The hooks alone are not enough — `devkit coverage-run`, IDE runners and bare
 * `vitest` spawn vitest directly, skip npm lifecycle hooks, and failed at import in every fresh
 * worktree.
 *
 * The probe is package-local: a dependency counts as installed only under the package's own
 * node_modules, which is where `npm ci` puts it. devDependencies count too — relay's suite imports
 * socket.io-client — and the install passes --include=dev so NODE_ENV=production can't drop them. Node resolution would walk up into the root
 * node_modules, where hoisted copies of some deps (express, zod) already resolve, so a sibling
 * whose remaining deps also got hoisted would read as installed while never having been.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIBLING_PACKAGES = ['relay', 'live-activity-forwarder'];

const ROOT = resolve(import.meta.dirname, '../..');
// Longer than any sane `npm ci`; a lock older than this was left by a killed run.
const STALE_LOCK_MS = 10 * 60_000;
const LOCK_POLL_MS = 500;
// A breaker is held only for a stat, a read and an rm; one older than this was left by a killed run.
const STALE_BREAKER_MS = 30_000;

/** Declared dependencies and devDependencies missing from `pkgDir`'s own node_modules. */
export function findMissingDeps(pkgDir) {
  const { dependencies = {}, devDependencies = {} } = JSON.parse(
    readFileSync(join(pkgDir, 'package.json'), 'utf8'),
  );
  return Object.keys({ ...dependencies, ...devDependencies }).filter(
    (name) => !existsSync(join(pkgDir, 'node_modules', name, 'package.json')),
  );
}

/** In tmpdir so nothing needs ignoring and `npm ci` (which wipes node_modules) can't remove it. */
function defaultLockPath(pkgDir) {
  const key = createHash('sha256').update(pkgDir).digest('hex').slice(0, 16);
  return join(tmpdir(), `frink-ensure-deps-${key}.lock`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function npmCi(pkgDir) {
  execSync(`npm ci --include=dev --prefix "${pkgDir}"`, { stdio: 'inherit' });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLockPid(lockPath) {
  try {
    return Number(readFileSync(join(lockPath, 'pid'), 'utf8').trim());
  } catch {
    return Number.NaN;
  }
}

/**
 * A lock is abandoned when the holder pid it records is no longer running. Before the pid is
 * written (an empty file read mid-write would be pid 0, the process group) only age can tell.
 * Throws ENOENT once the lock has been released.
 */
function isAbandoned(lockPath) {
  const pid = readLockPid(lockPath);
  if (Number.isInteger(pid) && pid > 0) return !isAlive(pid);
  return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
}

/**
 * Removes the lock only if it is STILL abandoned, judged again while holding `<lock>.break`. A
 * waiter's earlier verdict can be stale: another waiter may already have broken the lock and taken
 * a fresh one, and removing that would let two `npm ci` runs share one node_modules. Returns
 * whether the lock was removed; false means "retry later".
 */
export function breakAbandonedLock(lockPath) {
  const breaker = `${lockPath}.break`;
  try {
    mkdirSync(breaker);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(breaker).mtimeMs > STALE_BREAKER_MS) {
        rmSync(breaker, { recursive: true, force: true });
      }
    } catch {
      // The other breaker finished between mkdir and stat.
    }
    return false;
  }
  try {
    if (!isAbandoned(lockPath)) return false;
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false; // Released meanwhile: the caller retries at once.
    throw error;
  } finally {
    rmSync(breaker, { recursive: true, force: true });
  }
}

/** `mkdir` is atomic: exactly one concurrent caller creates the directory. */
function acquireLock(lockPath, sleep) {
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'pid'), String(process.pid));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let abandoned;
    try {
      abandoned = isAbandoned(lockPath);
    } catch {
      continue; // Released between mkdir and the check: retry at once.
    }
    if (!abandoned || !breakAbandonedLock(lockPath)) sleep(LOCK_POLL_MS);
  }
}

/** Releases only a lock that still records this process, never one another run has since taken. */
function releaseLock(lockPath) {
  if (readLockPid(lockPath) === process.pid) rmSync(lockPath, { recursive: true, force: true });
}

/**
 * Installs each sibling package whose dependencies are missing. Concurrent callers on one
 * checkout (several agents' test runs in a worktree) serialize on a per-package lock and re-probe
 * once they hold it, so only the first one installs.
 *
 * `strict: false` turns a failed install into a warning naming the package, so a globalSetup
 * that can't install (offline, no npm) fails only that package's suites, not the whole run.
 */
export function ensurePackageDeps({
  strict = true,
  root = ROOT,
  packages = SIBLING_PACKAGES,
  install = npmCi,
  log = console.log,
  sleep = sleepSync,
  lockPathFor = defaultLockPath,
} = {}) {
  for (const pkg of packages) {
    const pkgDir = join(root, pkg);
    if (findMissingDeps(pkgDir).length === 0) continue;

    const lockPath = lockPathFor(pkgDir);
    acquireLock(lockPath, sleep);
    try {
      const missing = findMissingDeps(pkgDir);
      if (missing.length > 0) {
        log(`[ensure-deps] installing ${pkg} (unresolved: ${missing.join(', ')})…`);
        install(pkgDir);
      }
    } catch (error) {
      if (strict) throw error;
      log(
        `[ensure-deps] could not install ${pkg}; its suites will fail at import: ${error.message}`,
      );
    } finally {
      releaseLock(lockPath);
    }
  }
}

/** vitest `globalSetup` entry. */
export default function setup() {
  ensurePackageDeps({ strict: false });
}

/** Node runs the main module from its realpath, so compare realpaths, not the argv spelling. */
export function isCliEntry(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  ensurePackageDeps();
}
