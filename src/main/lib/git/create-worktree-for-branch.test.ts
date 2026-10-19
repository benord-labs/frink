/**
 * Regression tests for Start Task worktrees: local branch names must use
 * generateBranchName() (adjective-animal-hex), not flow/PR-style names.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canInitGit } from '../test-utils';

import { resolveWorktreeBasePath } from '../worktree/base-path-config';

vi.mock('../worktree/base-path-config', () => ({
  resolveWorktreeBasePath: vi.fn(),
}));

import { createWorktreeError, createWorktreeForBranch, generateBranchName } from './worktree';

/** Matches createWorktreeForBranch / chat branch naming (no flow/ prefix, no slashes). */
const FLOW_LOCAL_BRANCH_RE = /^[a-z]+-[a-z]+-[0-9a-f]{6}$/;

function initGitRepoWithBaseBranch(baseBranch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'frink-start-task-repo-'));
  const emptyTemplate = mkdtempSync(join(tmpdir(), 'frink-git-empty-template-'));
  try {
    execSync('git init -b main', {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, GIT_TEMPLATE_DIR: emptyTemplate },
    });
  } finally {
    rmSync(emptyTemplate, { recursive: true, force: true });
  }
  execSync('git config user.email frink-test@local', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Frink Test', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), 'x\n');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe' });
  execSync(['git', 'branch', baseBranch].join(' '), { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('generateBranchName', () => {
  it('produces adjective-animal-6hex segments (Start Task / chat parity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const name = generateBranchName();
      expect(name).toMatch(FLOW_LOCAL_BRANCH_RE);
      expect(name.startsWith('flow/')).toBe(false);
      expect(name).not.toContain('/');
      seen.add(name);
    }
    expect(seen.size).toBeGreaterThan(30);
  });
});

// Users only see this message when worktree creation fails, so each git failure keeps its own guidance.
describe('createWorktreeError', () => {
  it('explains a git lock held by another process', () => {
    const error = createWorktreeError("fatal: Unable to lock '.git/index.lock'", false);
    expect(error.message).toContain('locked by another process');
  });

  it('explains a missing or failing git-lfs, from the message or because the repo uses LFS', () => {
    expect(createWorktreeError('smudge filter lfs failed', false).message).toContain(
      'uses Git LFS',
    );
    expect(createWorktreeError('lfs object missing', true).message).toContain('uses Git LFS');
  });

  it('passes any other failure through with its own text', () => {
    expect(createWorktreeError('invalid reference: nope', false).message).toBe(
      'Failed to create worktree: invalid reference: nope',
    );
  });
});

describe.skipIf(!canInitGit)('createWorktreeForBranch (git integration)', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    while (createdDirs.length > 0) {
      const d = createdDirs.pop();
      if (d) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
    vi.mocked(resolveWorktreeBasePath).mockReset();
  });

  it('uses generateBranchName-style local branch and reports the chosen base branch', async () => {
    const wtBase = mkdtempSync(join(tmpdir(), 'frink-wt-flow-base-'));
    createdDirs.push(wtBase);
    vi.mocked(resolveWorktreeBasePath).mockResolvedValue(wtBase);

    const baseBranch = 'feature/pr-head';
    const repo = initGitRepoWithBaseBranch(baseBranch);
    createdDirs.push(repo);

    const result = await createWorktreeForBranch(repo, 'flowproj', baseBranch);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.baseBranch).toBe(baseBranch);
    expect(result.branch).toBeDefined();
    expect(result.branch).toMatch(FLOW_LOCAL_BRANCH_RE);
    expect(result.branch?.startsWith('flow/')).toBe(false);
    expect(result.worktreePath).toContain(join(wtBase, 'flowproj'));
  });

  it('omitting branch uses default local branch and still names worktree branch with generateBranchName', async () => {
    const wtBase = mkdtempSync(join(tmpdir(), 'frink-wt-flow-base-'));
    createdDirs.push(wtBase);
    vi.mocked(resolveWorktreeBasePath).mockResolvedValue(wtBase);

    const repo = initGitRepoWithBaseBranch('unused-side-branch');
    createdDirs.push(repo);

    const result = await createWorktreeForBranch(repo, 'noparam', undefined);

    expect(result.success).toBe(true);
    expect(result.baseBranch).toBe('main');
    expect(result.branch).toMatch(FLOW_LOCAL_BRANCH_RE);
  });

  it('copies the ignored .env in before setup commands run, with no worktree config', async () => {
    const wtBase = mkdtempSync(join(tmpdir(), 'frink-wt-flow-base-'));
    createdDirs.push(wtBase);
    vi.mocked(resolveWorktreeBasePath).mockResolvedValue(wtBase);

    const repo = initGitRepoWithBaseBranch('unused-side-branch');
    createdDirs.push(repo);
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    execSync('git add .gitignore && git commit -m ignore', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, '.env'), 'API_KEY=local\n');

    const plain = await createWorktreeForBranch(repo, 'envcopy', undefined);
    expect(plain.success).toBe(true);
    expect(readFileSync(join(plain.worktreePath ?? '', '.env'), 'utf8')).toBe('API_KEY=local\n');

    mkdirSync(join(repo, '.frink'), { recursive: true });
    writeFileSync(
      join(repo, '.frink', 'worktrees.json'),
      JSON.stringify({ 'setup-worktree': ['test -f .env'] }),
    );
    const withSetup = await createWorktreeForBranch(repo, 'envsetup', undefined);
    expect(withSetup.error).toBeUndefined();
    expect(withSetup.success).toBe(true);
  });

  // The failure result carries no worktreePath, so nothing downstream could find the directory
  // to clean it up later — a leaked worktree + branch would accumulate on every failed setup.
  it('rolls the worktree and branch back when setup commands fail', async () => {
    const wtBase = mkdtempSync(join(tmpdir(), 'frink-wt-flow-base-'));
    createdDirs.push(wtBase);
    vi.mocked(resolveWorktreeBasePath).mockResolvedValue(wtBase);

    const repo = initGitRepoWithBaseBranch('unused-side-branch');
    createdDirs.push(repo);
    mkdirSync(join(repo, '.frink'), { recursive: true });
    writeFileSync(
      join(repo, '.frink', 'worktrees.json'),
      JSON.stringify({ 'setup-worktree': ['exit 3'] }),
    );

    const result = await createWorktreeForBranch(repo, 'rollback', undefined);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Worktree setup failed');

    const listed = execSync('git worktree list --porcelain', { cwd: repo }).toString();
    expect(listed).not.toContain(join(wtBase, 'rollback'));
    // `git worktree remove` takes the leaf; the empty slug parent is the orphan sweep's job.
    expect(readdirSync(join(wtBase, 'rollback'))).toHaveLength(0);

    const branches = execSync("git branch --format='%(refname:short)'", { cwd: repo }).toString();
    expect(branches.split('\n').filter((b) => FLOW_LOCAL_BRANCH_RE.test(b))).toHaveLength(0);
  });
});
