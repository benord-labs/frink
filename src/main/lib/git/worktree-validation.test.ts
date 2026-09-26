import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateWorktreeForReuse } from './worktree-validation';

describe('validateWorktreeForReuse — permanent vs transient classification', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wt-validation-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Worktree-shaped dir: a `.git` FILE pointing at a separate gitdir. */
  async function makeWorktreeShape(): Promise<{ worktree: string; gitDir: string }> {
    const worktree = join(root, 'worktree');
    const gitDir = join(root, 'gitdir');
    await mkdir(worktree);
    await mkdir(gitDir);
    await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    return { worktree, gitDir };
  }

  it('missing path is invalid and permanent', async () => {
    const result = await validateWorktreeForReuse(join(root, 'does-not-exist'));
    expect(result).toMatchObject({ valid: false, permanent: true });
  });

  it('path that is a file (not a directory) is invalid and permanent', async () => {
    const file = join(root, 'a-file');
    await writeFile(file, 'x');
    const result = await validateWorktreeForReuse(file);
    expect(result).toMatchObject({ valid: false, permanent: true });
  });

  it('main repository (.git directory) is invalid and permanent', async () => {
    const repo = join(root, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    const result = await validateWorktreeForReuse(repo);
    expect(result).toMatchObject({ valid: false, permanent: true });
  });

  it('directory without .git is invalid and permanent', async () => {
    const bare = join(root, 'bare');
    await mkdir(bare);
    const result = await validateWorktreeForReuse(bare);
    expect(result).toMatchObject({ valid: false, permanent: true });
  });

  it('in-progress git operation (rebase-merge) is invalid but transient', async () => {
    const { worktree, gitDir } = await makeWorktreeShape();
    await mkdir(join(gitDir, 'rebase-merge'));
    const result = await validateWorktreeForReuse(worktree);
    expect(result).toMatchObject({ valid: false, permanent: false });
    expect(result.valid === false && result.reason).toContain('rebase-merge');
  });

  it('index.lock is invalid but transient', async () => {
    const { worktree, gitDir } = await makeWorktreeShape();
    await writeFile(join(gitDir, 'index.lock'), '');
    const result = await validateWorktreeForReuse(worktree);
    expect(result).toMatchObject({ valid: false, permanent: false });
    expect(result.valid === false && result.reason).toContain('index.lock');
  });
});
