/**
 * Shared test helpers for custom-nodes test suites.
 */

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CustomNodeManifest } from './discovery';

export function writeCustomNodeFixture(
  baseDir: string,
  dirName: string,
  manifest: unknown,
  scriptContent = 'console.log("ok")',
): void {
  const dir = join(baseDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const raw =
    typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)
      : {};
  const requestedEntrypoint = raw.entrypoint;
  const entrypoint =
    typeof requestedEntrypoint === 'string' && requestedEntrypoint === basename(requestedEntrypoint)
      ? requestedEntrypoint
      : 'run.js';
  writeFileSync(join(dir, entrypoint), scriptContent);
}

export function makeManifest(overrides: Partial<CustomNodeManifest> = {}): CustomNodeManifest {
  return {
    name: 'test-node',
    displayName: 'Test Node',
    description: '',
    version: '1.0.0',
    entrypoint: 'run.js',
    timeout: 60,
    inputs: {},
    credentials: {},
    nodePath: '/mock/nodes/test-node',
    ...overrides,
  };
}

function isInside(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
}

/** Realpath of the deepest existing ancestor plus the missing tail, so a symlinked parent cannot hide the true target. */
function canonical(dir: string): string {
  let existing = resolve(dir);
  const tail: string[] = [];
  while (!existsSync(existing)) {
    tail.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync.native(existing), ...tail);
}

/** Deletes a test fixture dir; throws for anything outside `root` (the OS temp dir) so a suite can never remove real user data. */
export function removeTestDir(dir: string, root: string = tmpdir()): void {
  const target = canonical(dir);
  if (!isInside(target, canonical(root))) {
    throw new Error(`Refusing to delete ${target}: test fixtures must live under ${root}`);
  }
  rmSync(target, { recursive: true, force: true });
}
