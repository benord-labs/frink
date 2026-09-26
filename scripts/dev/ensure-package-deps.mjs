#!/usr/bin/env node
/**
 * Test-time gate: the root vitest config collects the sibling packages listed below, but each is
 * an independently deployed package carrying its own npm lockfile that a root `bun install` never
 * touches. Every clean checkout — a git worktree, a fresh clone, a CI runner — therefore reaches
 * those suites with the dependencies absent and fails at import.
 *
 * It belongs in `pretest` and not in the root `postinstall`: the dependency is on RUNNING the
 * tests, and `npm ci` wipes and rebuilds node_modules, so installing at postinstall would charge
 * every root `bun install` a full sibling reinstall and let a sibling lockfile problem fail the
 * root install outright. Resolving a declared runtime dependency is the cheap, honest probe for
 * "is this tree installed", so the install runs only when one cannot be found.
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

for (const pkg of ['relay']) {
  const packageRequire = createRequire(new URL(`../../${pkg}/package.json`, import.meta.url));

  const unresolved = Object.keys(packageRequire('./package.json').dependencies).filter((name) => {
    try {
      packageRequire.resolve(name);
      return false;
    } catch {
      return true;
    }
  });

  if (unresolved.length > 0) {
    console.log(`[ensure-deps] installing ${pkg} (unresolved: ${unresolved.join(', ')})…`);
    execSync(`npm ci --prefix ${pkg}`, { stdio: 'inherit' });
  }
}
