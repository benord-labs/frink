/**
 * Tests for `drainInFlightRollbackStashes` — the graceful-shutdown helper that
 * waits for any in-flight `createRollbackStash` promises before app exit.
 *
 * Without this, an Electron `before-quit` that fires while a stash is still
 * running can drop the promise mid-`git add -A`, leaving an orphan
 * `.git/index.lock` that breaks the next launch's git ops until manually
 * cleaned up.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('simple-git', () => ({
  default: vi.fn(),
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import simpleGit from 'simple-git';
import { gitAsTestUser } from '../test-utils/git-as-test-user';
import { applyRollbackStash, createRollbackStash, drainInFlightRollbackStashes } from './stash';

const repos: string[] = [];

/** Real repo, so the temp-index git calls run for real; simple-git stays mocked. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stash-drain-test-'));
  gitAsTestUser(dir, 'init', '-q');
  repos.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Deferred = { promise: Promise<string>; resolve: (value: string) => void };
function deferred(): Deferred {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mockGitWithSlowCommit(commitDeferred: Deferred) {
  // git.raw sequence per stash: rev-parse --git-path index, commit-tree (blocks), update-ref.
  const git = {
    raw: vi.fn(),
    checkIsRepo: vi.fn().mockResolvedValue(true),
  };
  git.raw
    .mockResolvedValueOnce('.git/index\n')
    .mockImplementationOnce(() => commitDeferred.promise)
    .mockResolvedValueOnce('');
  return git;
}

describe('drainInFlightRollbackStashes', () => {
  const simpleGitMock = vi.mocked(simpleGit);

  beforeEach(() => {
    simpleGitMock.mockReset();
  });

  it('returns immediately when no stash is in flight', async () => {
    const start = Date.now();
    await drainInFlightRollbackStashes(50);
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('waits for an in-flight stash to settle before resolving', async () => {
    const slow = deferred();
    simpleGitMock.mockReturnValue(mockGitWithSlowCommit(slow) as never);

    const stashPromise = createRollbackStash(initRepo(), 'uuid-drain-1');

    let drainResolved = false;
    const drainPromise = drainInFlightRollbackStashes(2000).then(() => {
      drainResolved = true;
    });

    // Yield twice so any synchronous-ish path has a chance to resolve drain prematurely.
    await Promise.resolve();
    await Promise.resolve();
    expect(drainResolved).toBe(false);

    // Release the slow commit-tree; both stash and drain should complete now.
    slow.resolve('commit-hash\n');
    await stashPromise;
    await drainPromise;
    expect(drainResolved).toBe(true);
  });

  it('respects timeoutMs when a stash hangs forever', async () => {
    const neverResolves = deferred();
    simpleGitMock.mockReturnValue(mockGitWithSlowCommit(neverResolves) as never);

    const hangingStash = createRollbackStash(initRepo(), 'uuid-drain-2');

    const start = Date.now();
    await drainInFlightRollbackStashes(120);
    const elapsed = Date.now() - start;

    // Drain should give up at ~120ms; allow generous slack for CI scheduling jitter.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(800);

    // Release the deferred and await the stash so it removes itself from the
    // module-level inFlightStashes Set before the next test runs. Without this,
    // a leaked entry would make subsequent drain calls wait on a dead promise.
    neverResolves.resolve('commit-hash\n');
    await hangingStash;
  });
});

describe('applyRollbackStash serialization', () => {
  const simpleGitMock = vi.mocked(simpleGit);

  beforeEach(() => {
    simpleGitMock.mockReset();
  });

  it('waits for an in-flight createRollbackStash on the same cwd before applying', async () => {
    const slow = deferred();
    const reachedCommit = deferred();
    const callOrder: string[] = [];

    // create stash's commit-tree blocks on `slow`.
    const createGit = {
      raw: vi.fn(async (cmd: string[]) => {
        if (cmd[0] === 'rev-parse') {
          return '.git/index\n';
        }
        if (cmd[0] === '-c') {
          callOrder.push('create-commit-tree');
          reachedCommit.resolve('');
          await slow.promise;
          return 'commit-hash\n';
        }
        if (cmd[0] === 'update-ref') {
          callOrder.push('create-update-ref');
          return '';
        }
        return '';
      }),
      checkIsRepo: vi.fn().mockResolvedValue(true),
    };

    // apply rollback's first call is rev-parse; we short-circuit so it returns
    // checkpointFound:false without running the destructive write phase.
    const applyGit = {
      raw: vi.fn(async (cmd: string[]) => {
        if (cmd[0] === 'rev-parse') {
          callOrder.push('apply-rev-parse');
          throw new Error('not found');
        }
        return '';
      }),
      checkIsRepo: vi.fn().mockResolvedValue(true),
    };

    simpleGitMock
      .mockReturnValueOnce(createGit as never) // create
      .mockReturnValue(applyGit as never); // apply

    const cwd = initRepo();
    const createPromise = createRollbackStash(cwd, 'uuid-create');

    // Create runs real temp-index git first, so wait for it to park on commit-tree.
    await reachedCommit.promise;

    // Now fire apply — it must queue behind the in-flight create.
    const applyPromise = applyRollbackStash(cwd, 'uuid-old');
    // Give apply a chance to start (it would, if not blocked).
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    // apply-rev-parse must NOT have run yet — it's blocked on create.
    expect(callOrder).not.toContain('apply-rev-parse');

    // Release create. Both promises should now resolve, with apply running last.
    slow.resolve('');
    await createPromise;
    const applyResult = await applyPromise;

    expect(applyResult).toEqual({ success: true, checkpointFound: false });
    expect(callOrder.indexOf('apply-rev-parse')).toBeGreaterThan(
      callOrder.indexOf('create-update-ref'),
    );
  });
});
