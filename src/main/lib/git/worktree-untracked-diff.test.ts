import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { splitUnifiedDiffByFile } from './diff-parser';
import { getWorktreeDiff } from './worktree';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'untracked-diff-'));
  git('init', '-q');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('-c', 'user.name=Frink', '-c', 'user.email=frink@example.com', 'commit', '-qm', 'a');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('getWorktreeDiff untracked files', () => {
  it('diffs a small untracked file and lists an oversized one as binary without diffing it', async () => {
    writeFileSync(path.join(repo, 'small.txt'), 'hello\n');
    writeFileSync(path.join(repo, 'trace.json'), 'x'.repeat(2 * 1024 * 1024));

    const result = await getWorktreeDiff(repo, undefined, { onlyUncommitted: true });

    expect(result.success).toBe(true);
    const files = splitUnifiedDiffByFile(result.diff ?? '');
    const small = files.find((f) => f.newPath === 'small.txt');
    const big = files.find((f) => f.newPath === 'trace.json');
    expect(small).toMatchObject({ isBinary: false, additions: 1 });
    expect(big).toMatchObject({ isBinary: true, additions: 0 });
    expect(result.diff).not.toContain('xxxx');
  });
});
