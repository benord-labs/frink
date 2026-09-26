/**
 * Concurrent createRollbackStash regression tests.
 *
 * Context: as of the perf fix that moved createRollbackStash off the agent
 * completion critical path (see executor.ts), two stashes can now race against
 * the same working tree — multi-pane sub-chats inside one chat share a worktree,
 * and queued messages can fire turn N+1 while turn N's stash is still walking
 * the tree. This file exercises that scenario against a real on-disk git repo.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRollbackStash } from './stash';

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stash-concurrent-test-'));
  execSync('git init -q --initial-branch=main', { cwd: dir });
  execSync('git config user.email "test@local"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execSync('git add . && git commit -q -m "seed"', { cwd: dir });
  return dir;
}

function refExists(cwd: string, ref: string): boolean {
  try {
    execSync(`git rev-parse --verify ${ref}`, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const repos: string[] = [];

afterEach(() => {
  while (repos.length > 0) {
    const dir = repos.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup races on macOS
      }
    }
  }
});

describe('createRollbackStash concurrency', () => {
  it('two concurrent stashes against the same cwd both produce valid checkpoint refs', async () => {
    const cwd = initRepo();
    repos.push(cwd);

    // Make the worktree dirty so `git add -A` has real work to do — this is
    // where contention would surface if simple-git or git itself raced.
    for (let i = 0; i < 25; i += 1) {
      writeFileSync(join(cwd, `file-${i}.txt`), `content-${i}\n`);
    }

    const uuidA = '11111111-1111-1111-1111-111111111111';
    const uuidB = '22222222-2222-2222-2222-222222222222';

    const [resA, resB] = await Promise.allSettled([
      createRollbackStash(cwd, uuidA),
      createRollbackStash(cwd, uuidB),
    ]);

    expect(resA.status).toBe('fulfilled');
    expect(resB.status).toBe('fulfilled');
    expect(refExists(cwd, `refs/checkpoints/${uuidA}`)).toBe(true);
    expect(refExists(cwd, `refs/checkpoints/${uuidB}`)).toBe(true);
  });

  it('concurrent stashes do not orphan a .git/index.lock', async () => {
    const cwd = initRepo();
    repos.push(cwd);

    for (let i = 0; i < 10; i += 1) {
      writeFileSync(join(cwd, `f-${i}.txt`), `x-${i}\n`);
    }

    await Promise.allSettled([
      createRollbackStash(cwd, '33333333-3333-3333-3333-333333333333'),
      createRollbackStash(cwd, '44444444-4444-4444-4444-444444444444'),
      createRollbackStash(cwd, '55555555-5555-5555-5555-555555555555'),
    ]);

    // After all three resolve, a fresh git op must succeed — if either lock
    // file from .git/index.lock or refs/checkpoints/*.lock survived, this
    // would fail with "Another git process seems to be running".
    expect(() => execSync('git status -s', { cwd, stdio: 'pipe' })).not.toThrow();
  });

  it('parallel stashes against different cwds run independently', async () => {
    const cwdA = initRepo();
    const cwdB = initRepo();
    repos.push(cwdA, cwdB);

    writeFileSync(join(cwdA, 'a.txt'), 'a\n');
    writeFileSync(join(cwdB, 'b.txt'), 'b\n');

    const uuidA = '66666666-6666-6666-6666-666666666666';
    const uuidB = '77777777-7777-7777-7777-777777777777';

    await Promise.all([createRollbackStash(cwdA, uuidA), createRollbackStash(cwdB, uuidB)]);

    expect(refExists(cwdA, `refs/checkpoints/${uuidA}`)).toBe(true);
    expect(refExists(cwdB, `refs/checkpoints/${uuidB}`)).toBe(true);
    // Cross-contamination check: A's ref must not exist in B's repo.
    expect(refExists(cwdB, `refs/checkpoints/${uuidA}`)).toBe(false);
    expect(refExists(cwdA, `refs/checkpoints/${uuidB}`)).toBe(false);
  });
});
