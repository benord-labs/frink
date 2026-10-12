#!/usr/bin/env node
/**
 * Type-checks every TypeScript project in the repo and fails if any of them does.
 *
 * Each project runs even when an earlier one is red, so one project's errors cannot hide
 * another's. Chaining the runs with `&&` stopped at the first failure, which left the later
 * projects unchecked and their errors unprinted.
 *
 * The compiler is resolved through its package and run by explicit path: `node_modules/.bin/tsc`
 * is ambiguous between TypeScript versions here.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A project without `tsconfig` is the one tsc finds at the root. */
export const PROJECTS = [
  { name: 'root' },
  { name: 'relay', tsconfig: 'relay/tsconfig.test.json' },
  { name: 'live-activity-forwarder', tsconfig: 'live-activity-forwarder/tsconfig.json' },
];

const require = createRequire(import.meta.url);

function tscPath() {
  return join(dirname(require.resolve('@typescript/native/package.json')), 'bin/tsc');
}

/** Diagnostics go straight to the inherited stdio, with paths relative to `root`. */
export function runProject(project, root, spawn = spawnSync) {
  const args = [tscPath(), '--noEmit', ...(project.tsconfig ? ['-p', project.tsconfig] : [])];
  const result = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status === null) return { ok: false, reason: `killed by ${result.signal}` };
  return result.status === 0
    ? { ok: true, reason: 'passed' }
    : { ok: false, reason: `exit ${result.status}` };
}

/** Runs every project in order; a failure never stops the ones after it. */
export function runTsCheck({ root = REPO_ROOT, projects = PROJECTS, run = runProject } = {}) {
  const results = projects.map((project) => ({ name: project.name, ...run(project, root) }));
  return { results, exitCode: results.every((result) => result.ok) ? 0 : 1 };
}

/** Checks the repo, or the directory after `--root`, and returns the process exit code. */
export function main(argv = process.argv, { run = runProject, log = console.error } = {}) {
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag === -1 ? REPO_ROOT : resolve(argv[rootFlag + 1] ?? '');
  const { results, exitCode } = runTsCheck({ root, run });
  for (const result of results) {
    log(`[ts:check] ${result.name}: ${result.ok ? 'passed' : `failed (${result.reason})`}`);
  }
  return exitCode;
}

// Node loads the entry script by its real path, so argv is resolved the same way: comparing the
// raw path would skip the whole check, and exit 0, when the script is reached through a symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
