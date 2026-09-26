/**
 * Tests for `drainInFlightRollbackStashes` — the graceful-shutdown helper that
 * waits for any in-flight `createRollbackStash` promises before app exit.
 *
 * Without this, an Electron `before-quit` that fires while a stash is still
 * running can drop the promise mid-`git add -A`, leaving an orphan
 * `.git/index.lock` that breaks the next launch's git ops until manually
 * cleaned up.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('simple-git', () => ({
  default: vi.fn(),
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import simpleGit from 'simple-git';
import { applyRollbackStash, createRollbackStash, drainInFlightRollbackStashes } from './stash';

type Deferred = { promise: Promise<string>; resolve: (value: string) => void };
function deferred(): Deferred {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mockGitWithSlowAdd(addDeferred: Deferred) {
  // Each call to `git.raw([...])` returns a different value. Sequence per stash:
  //  1. write-tree (main index)        → 'index-tree-hash'
  //  2. (temp)  add -A                 → blocks on addDeferred
  //  3. (temp)  write-tree             → 'worktree-tree-hash'
  //  4.        commit-tree             → 'commit-hash'
  //  5.        update-ref              → ''
  const git = {
    raw: vi.fn(),
    checkIsRepo: vi.fn().mockResolvedValue(true),
    env: vi.fn(),
  };
  git.raw
    .mockResolvedValueOnce('index-tree-hash\n')
    .mockResolvedValueOnce('commit-hash\n')
    .mockResolvedValueOnce('');
  git.env.mockReturnValue({
    raw: vi
      .fn()
      .mockImplementationOnce(() => addDeferred.promise) // add -A
      .mockResolvedValueOnce('worktree-tree-hash\n'), // write-tree (temp)
  });
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
    simpleGitMock.mockReturnValue(mockGitWithSlowAdd(slow) as never);

    const stashPromise = createRollbackStash('/tmp/repo-drain-1', 'uuid-drain-1');

    let drainResolved = false;
    const drainPromise = drainInFlightRollbackStashes(2000).then(() => {
      drainResolved = true;
    });

    // Yield twice so any synchronous-ish path has a chance to resolve drain prematurely.
    await Promise.resolve();
    await Promise.resolve();
    expect(drainResolved).toBe(false);

    // Release the slow `git add -A`; both stash and drain should complete now.
    slow.resolve('');
    await stashPromise;
    await drainPromise;
    expect(drainResolved).toBe(true);
  });

  it('respects timeoutMs when a stash hangs forever', async () => {
    const neverResolves = deferred();
    simpleGitMock.mockReturnValue(mockGitWithSlowAdd(neverResolves) as never);

    const hangingStash = createRollbackStash('/tmp/repo-drain-2', 'uuid-drain-2');

    const start = Date.now();
    await drainInFlightRollbackStashes(120);
    const elapsed = Date.now() - start;

    // Drain should give up at ~120ms; allow generous slack for CI scheduling jitter.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(800);

    // Release the deferred and await the stash so it removes itself from the
    // module-level inFlightStashes Set before the next test runs. Without this,
    // a leaked entry would make subsequent drain calls wait on a dead promise.
    neverResolves.resolve('');
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
    const callOrder: string[] = [];

    // create stash uses the temp-index env; its add -A blocks on `slow`.
    const tempEnvRaw = vi.fn(async (cmd: string[]) => {
      if (cmd[0] === 'add') {
        callOrder.push('create-add');
        await slow.promise;
        return '';
      }
      if (cmd[0] === 'write-tree') {
        callOrder.push('create-write-tree-temp');
        return 'worktree-tree-hash\n';
      }
      return '';
    });
    const createGit = {
      raw: vi.fn(async (cmd: string[]) => {
        if (cmd[0] === 'write-tree') {
          callOrder.push('create-write-tree-main');
          return 'index-tree-hash\n';
        }
        if (cmd[0] === '-c') {
          callOrder.push('create-commit-tree');
          return 'commit-hash\n';
        }
        if (cmd[0] === 'update-ref') {
          callOrder.push('create-update-ref');
          return '';
        }
        return '';
      }),
      checkIsRepo: vi.fn().mockResolvedValue(true),
      env: vi.fn().mockReturnValue({ raw: tempEnvRaw }),
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
      env: vi.fn(),
    };

    // createRollbackStashInner calls simpleGit(cwd) twice: once for the main
    // index ops, once for the temp-index env wrapper. applyRollbackStashInner
    // calls it once. Order matters.
    simpleGitMock
      .mockReturnValueOnce(createGit as never) // create: outer
      .mockReturnValueOnce(createGit as never) // create: temp-index wrapper
      .mockReturnValue(applyGit as never); // apply

    const cwd = '/tmp/repo-serialize';
    const createPromise = createRollbackStash(cwd, 'uuid-create');

    // Drain ticks until create reaches its parked `add -A`. mkdtemp is real
    // filesystem I/O so it takes a handful of macrotasks to thread through.
    const waitFor = async (predicate: () => boolean, label: string) => {
      for (let i = 0; i < 100; i += 1) {
        if (predicate()) return;
        await new Promise((r) => setImmediate(r));
      }
      throw new Error(`Timed out waiting for: ${label}; callOrder=${JSON.stringify(callOrder)}`);
    };
    await waitFor(() => callOrder.includes('create-add'), 'create-add');

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
