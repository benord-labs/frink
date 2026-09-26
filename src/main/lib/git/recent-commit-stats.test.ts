import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRecentCommitStats } from './recent-commit-stats';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

function commit(file: string, content: string) {
  writeFileSync(path.join(repo, file), content);
  git('add', file);
  git('-c', 'user.name=Frink', '-c', 'user.email=frink@example.com', 'commit', '-qm', file);
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'recent-stats-'));
  git('init', '-q');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('getRecentCommitStats', () => {
  it('sums the diffstat of the recent commits', async () => {
    commit('a.txt', 'one\ntwo\nthree\n');
    commit('a.txt', 'one\n');
    commit('b.txt', 'hi\n');
    expect(await getRecentCommitStats(repo)).toEqual({ commits: 3, insertions: 4, deletions: 2 });
  });

  it('only counts the last `count` commits', async () => {
    commit('a.txt', 'one\n');
    commit('b.txt', 'one\ntwo\n');
    expect(await getRecentCommitStats(repo, 1)).toEqual({
      commits: 1,
      insertions: 2,
      deletions: 0,
    });
  });

  it('returns null for a repo without commits or a non-repo', async () => {
    expect(await getRecentCommitStats(repo)).toBeNull();
    expect(await getRecentCommitStats(tmpdir())).toBeNull();
  });

  it('counts commits in a SHA-256 repository', async () => {
    rmSync(repo, { recursive: true, force: true });
    repo = mkdtempSync(path.join(tmpdir(), 'recent-stats-sha256-'));
    git('init', '-q', '--object-format=sha256');
    commit('a.txt', 'one\ntwo\n');
    expect(await getRecentCommitStats(repo)).toEqual({ commits: 1, insertions: 2, deletions: 0 });
  });

  it('counts no lines for binary files', async () => {
    commit('a.txt', 'one\n');
    writeFileSync(path.join(repo, 'b.bin'), Buffer.from([0, 1, 2, 0]));
    git('add', 'b.bin');
    git('-c', 'user.name=Frink', '-c', 'user.email=frink@example.com', 'commit', '-qm', 'bin');
    expect(await getRecentCommitStats(repo)).toEqual({ commits: 2, insertions: 1, deletions: 0 });
  });

  it('parses the summary even when the user runs git in another language', async () => {
    const lang = process.env.LANG;
    process.env.LANG = 'de_DE.UTF-8';
    try {
      commit('a.txt', 'one\ntwo\n');
      expect(await getRecentCommitStats(repo)).toEqual({ commits: 1, insertions: 2, deletions: 0 });
    } finally {
      process.env.LANG = lang;
    }
  });
});
