import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { splitUnifiedDiffByFile } from './diff-parser';
import { getWorktreeDiff as appWorktreeDiff } from './index';
import { createWorktreeDiff, MAX_UNTRACKED_DIFFED_FILES } from './worktree/diff';

/** Real git, observed: counts `git status` runs and can hold a run while that status is still pending. */
type GitProbe = {
  statusCalls: number;
  holdDuringStatus: null | { reached: () => void; release: Promise<void> };
};
const gitProbe: GitProbe = { statusCalls: 0, holdDuringStatus: null };

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
    expect(files.filter((f) => f.isBinary).map((f) => f.newPath)).toEqual(names.slice(0, extra));
    expect(files.at(-1)).toMatchObject({ isBinary: false, additions: 1 });
  });

  // git lists a nested repository as one directory entry, which cannot be read as a file.
  it('lists an untracked nested repository without reading it', async () => {
    const nested = path.join(repo, 'nested');
    execFileSync('git', ['init', '-q', nested]);
    writeFileSync(path.join(nested, 'inside.txt'), 'x\n');
    write('beside.txt', 'y\n');

    const result = await getWorktreeDiff(repo, undefined, { onlyUncommitted: true });

    expect(result.diff).toContain('Binary files /dev/null and b/nested/ differ');
    expect(diffedPaths(result.diff)).toContain('beside.txt');
  });

  // git itself reads through a link to a pipe, which blocks until something writes to it.
  it('shows an untracked link to a pipe by its target path, without opening the pipe', async () => {
    execFileSync('mkfifo', [path.join(repo, 'pipe')]);
    symlinkSync('pipe', path.join(repo, 'pipe-link'));

    const result = await getWorktreeDiff(repo, undefined, { onlyUncommitted: true });

    expect(result.diff).toContain(
      'diff --git a/pipe-link b/pipe-link\nnew file mode 120000\n--- /dev/null\n+++ b/pipe-link\n@@ -0,0 +1 @@\n+pipe\n',
    );
  });

  it('prints each untracked file exactly as `git diff --no-index /dev/null` does', async () => {
    const samples = {
      'lines.txt': 'a\nb\n',
      'no-eol.txt': 'a\nb',
      'one-line.txt': 'solo',
      'crlf.txt': 'x\r\ny\r\n',
      'empty.txt': '',
      'run.sh': '#!/bin/sh\necho hi\n',
      'blob.bin': 'head\0tail\n',
    };
    for (const [name, content] of Object.entries(samples)) write(name, content);
    chmodSync(path.join(repo, 'run.sh'), 0o755);
    // A link is shown by its target path and never followed: its target may sit outside the worktree.
    const links = { 'file-link': 'lines.txt', 'outside-link': '/etc/hosts' };
    for (const [name, target] of Object.entries(links)) symlinkSync(target, path.join(repo, name));
    const withoutIndex = (stanza: string) =>
      stanza
        .split('\n')
        .filter((line) => !line.startsWith('index '))
        .join('\n')
        .trimEnd();
    const gitStanza = (name: string) =>
      withoutIndex(
        spawnSync(
          'git',
          // Pinned so a developer's global prefix settings cannot change the expected text
          [
            '-c',
            'diff.noprefix=false',
            '-c',
            'diff.mnemonicPrefix=false',
            'diff',
            '--no-color',
            '--no-index',
            '/dev/null',
            name,
          ],
          { cwd: repo, encoding: 'utf8' },
        ).stdout,
      );

    const result = await getWorktreeDiff(repo, undefined, { onlyUncommitted: true });

    const stanzas = (result.diff ?? '')
      .split(/\n(?=diff --git )/)
      .map(withoutIndex)
      .sort();
    expect(stanzas).toEqual([...Object.keys(samples), ...Object.keys(links)].map(gitStanza).sort());
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
