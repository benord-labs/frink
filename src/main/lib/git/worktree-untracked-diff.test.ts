import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { splitUnifiedDiffByFile } from './diff-parser';
import { getWorktreeDiff as appWorktreeDiff } from './index';
import { createWorktreeDiff, MAX_UNTRACKED_DIFFED_FILES } from './worktree/diff';

/** Real git, observed: counts the spawns under test and can hold a run while its `git status` is still pending. */
type GitProbe = {
  statusCalls: number;
  untrackedDiffCalls: number;
  holdDuringStatus: null | { reached: () => void; release: Promise<void> };
};
const gitProbe: GitProbe = { statusCalls: 0, untrackedDiffCalls: 0, holdDuringStatus: null };

const getWorktreeDiff = createWorktreeDiff((worktreePath) => {
  const real = simpleGit(worktreePath);
  return {
    status: async () => {
      gitProbe.statusCalls += 1;
      const status = await real.status();
      const hold = gitProbe.holdDuringStatus;
      if (hold) {
        gitProbe.holdDuringStatus = null;
        hold.reached();
        await hold.release;
      }
      return status;
    },
    diff: (args) => real.diff(args),
    raw: async (args) => {
      if (args.includes('--no-index')) gitProbe.untrackedDiffCalls += 1;
      return real.raw(args);
    },
  };
});

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const commit = (message: string) =>
  git('-c', 'user.name=Frink', '-c', 'user.email=frink@example.com', 'commit', '-qm', message);
const write = (name: string, content: string) => writeFileSync(path.join(repo, name), content);
const diffedPaths = (diff: string | undefined) =>
  splitUnifiedDiffByFile(diff ?? '').map((f) => f.newPath);

/** Holds the next run after git read the worktree but before `git status` returns, until `release`. */
function holdNextRunDuringStatus() {
  let release = () => {};
  let reached = () => {};
  const isHeld = new Promise<void>((resolve) => {
    reached = resolve;
  });
  gitProbe.holdDuringStatus = {
    reached,
    release: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  return { isHeld, release };
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'untracked-diff-'));
  git('init', '-q');
  write('a.txt', 'one\n');
  git('add', 'a.txt');
  commit('a');
  gitProbe.statusCalls = 0;
  gitProbe.untrackedDiffCalls = 0;
  gitProbe.holdDuringStatus = null;
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('getWorktreeDiff untracked files', () => {
  it('diffs a small untracked file and lists an oversized one as binary without diffing it', async () => {
    write('small.txt', 'hello\n');
    write('trace.json', 'x'.repeat(2 * 1024 * 1024));

    const result = await appWorktreeDiff(repo, undefined, { onlyUncommitted: true });

    expect(result.success).toBe(true);
    const files = splitUnifiedDiffByFile(result.diff ?? '');
    const small = files.find((f) => f.newPath === 'small.txt');
    const big = files.find((f) => f.newPath === 'trace.json');
    expect(small).toMatchObject({ isBinary: false, additions: 1 });
    expect(big).toMatchObject({ isBinary: true, additions: 0 });
    expect(result.diff).not.toContain('xxxx');
  });

  it('leaves untracked lockfiles out of the diff', async () => {
    write('yarn.lock', 'lock\n');
    write('package-lock.json', '{}\n');
    write('pnpm-lock.yaml', 'lock\n');
    write('locksmith.txt', 'kept\n');

    const result = await getWorktreeDiff(repo, undefined, { onlyUncommitted: true });

    expect(diffedPaths(result.diff)).toEqual(['locksmith.txt']);
    expect(gitProbe.untrackedDiffCalls).toBe(1);
  });

  it('diffs only the most recently modified files past the file cap and lists the rest', async () => {
    const extra = 3;
    const names = Array.from(
      { length: MAX_UNTRACKED_DIFFED_FILES + extra },
      (_, i) => `f${String(i).padStart(4, '0')}.txt`,
    );
    const now = Date.now() / 1000;
    // The oldest files sort first by path, so a path-order cut would diff exactly the wrong ones.
    names.forEach((name, i) => {
      write(name, `${name}\n`);
      utimesSync(path.join(repo, name), now, now - (names.length - i) * 60);
    });

    const result = await getWorktreeDiff(repo, undefined, { onlyUncommitted: true });

    const files = splitUnifiedDiffByFile(result.diff ?? '');
    expect(files.map((f) => f.newPath)).toEqual(names);
    expect(gitProbe.untrackedDiffCalls).toBe(MAX_UNTRACKED_DIFFED_FILES);
    expect(files.filter((f) => f.isBinary).map((f) => f.newPath)).toEqual(names.slice(0, extra));
    expect(files.at(-1)).toMatchObject({ isBinary: false, additions: 1 });
  });
});

describe('getWorktreeDiff overlapping calls', () => {
  it('runs git once when several calls for one worktree overlap', async () => {
    write('one.txt', '1\n');
    write('two.txt', '2\n');
    write('three.txt', '3\n');
    const held = holdNextRunDuringStatus();

    const calls = Array.from({ length: 5 }, () =>
      getWorktreeDiff(repo, undefined, { onlyUncommitted: true }),
    );
    held.release();
    const results = await Promise.all(calls);

    expect(gitProbe.statusCalls).toBe(1);
    expect(gitProbe.untrackedDiffCalls).toBe(3);
    expect(diffedPaths(results[0].diff)).toEqual(['one.txt', 'three.txt', 'two.txt']);
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it('gives callers that arrive while git status is running one shared rerun with the newer state', async () => {
    write('before.txt', '1\n');
    const held = holdNextRunDuringStatus();
    const first = getWorktreeDiff(repo, undefined, { onlyUncommitted: true });
    await held.isHeld;

    write('later.txt', '2\n');
    const second = getWorktreeDiff(repo, undefined, { onlyUncommitted: true });
    const third = getWorktreeDiff(repo, undefined, { onlyUncommitted: true });
    held.release();

    expect(diffedPaths((await first).diff)).toEqual(['before.txt']);
    expect(diffedPaths((await second).diff)).toEqual(['before.txt', 'later.txt']);
    expect(diffedPaths((await third).diff)).toEqual(['before.txt', 'later.txt']);
    expect(gitProbe.statusCalls).toBe(2);
    expect(gitProbe.untrackedDiffCalls).toBe(3);
  });

  it('does not reuse a failed run for a later call', async () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), 'untracked-diff-plain-'));
    try {
      const [first, second] = await Promise.all([
        getWorktreeDiff(notARepo),
        getWorktreeDiff(notARepo),
      ]);
      expect(first.success).toBe(false);
      expect(second).toEqual(first);
      expect(gitProbe.statusCalls).toBe(1);

      expect((await getWorktreeDiff(notARepo)).success).toBe(false);
      expect(gitProbe.statusCalls).toBe(2);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('keeps branch-diff and uncommitted-only calls apart on a clean worktree', async () => {
    const base = git('branch', '--show-current').toString().trim();
    git('switch', '-qc', 'feature');
    write('b.txt', 'two\n');
    git('add', 'b.txt');
    commit('b');

    const [uncommitted, branch] = await Promise.all([
      getWorktreeDiff(repo, base, { onlyUncommitted: true }),
      getWorktreeDiff(repo, base),
    ]);

    expect(uncommitted).toEqual({ success: true, diff: '' });
    expect(diffedPaths(branch.diff)).toEqual(['b.txt']);
  });

  it('diffs a clean branch against the remote base when that ref exists', async () => {
    const base = git('branch', '--show-current').toString().trim();
    git('update-ref', `refs/remotes/origin/${base}`, 'HEAD');
    git('switch', '-qc', 'feature');
    write('b.txt', 'two\n');
    git('add', 'b.txt');
    commit('b');
    // The local base has caught up with the branch, so only the remote ref still shows b.txt.
    git('branch', '-f', base, 'feature');

    const result = await getWorktreeDiff(repo, base);

    expect(diffedPaths(result.diff)).toEqual(['b.txt']);
  });
});
