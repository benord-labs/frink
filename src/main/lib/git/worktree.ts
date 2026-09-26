/* eslint-disable max-lines */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import simpleGit from 'simple-git';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { computeExponentialBackoffMs } from '../retry-backoff';
import { captureContained } from '../sentry';
import { resolveWorktreeBasePath } from '../worktree/base-path-config';
import {
  isSafeConfiguredWorktreeBasePath,
  normalizeWorktreeBasePath,
} from '../worktree/base-path-validation';
import { checkGitLfsAvailable, getGitEnv } from './shell-env';
import { configureWorktreeHooks, persistFrinkOwnershipFlag } from './worktree/index';
import { awaitWorktreeSetup, detectWorktreeConfig, startWorktreeSetup } from './worktree-config';
import { generateWorktreeFolderName } from './worktree-naming';

export { configureWorktreeHooks, isFrinkManagedWorktree } from './worktree/index';

const execFileAsync = promisify(execFile);

// Regex constants
const ORIGIN_PREFIX_REGEX = /^origin\//;
const SYMBOLIC_REF_REGEX = /refs\/remotes\/origin\/(.+)/;
const SYMREF_MATCH_REGEX = /ref:\s+refs\/heads\/(.+?)\tHEAD/;
const PROJECT_SLUG_SINGLE_SEGMENT_REGEX = /^[A-Za-z0-9._-]+$/;
const WORKTREE_BLOCK_SPLIT_REGEX = /\n\n+/;

/**
 * Error thrown by execFile when the command fails.
 * `code` can be a number (exit code) or string (spawn error like "ENOENT").
 */
type ExecFileException = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals;
  cmd?: string;
  stdout?: string;
  stderr?: string;
};

function isExecFileException(error: unknown): error is ExecFileException {
  return error instanceof Error && ('code' in error || 'signal' in error || 'killed' in error);
}

async function repoUsesLfs(repoPath: string): Promise<boolean> {
  try {
    const lfsDir = join(repoPath, '.git', 'lfs');
    const stats = await stat(lfsDir);
    if (stats.isDirectory()) {
      return true;
    }
  } catch (error) {
    if (!isEnoent(error)) {
    }
  }

  const attributeFiles = [
    join(repoPath, '.gitattributes'),
    join(repoPath, '.git', 'info', 'attributes'),
    join(repoPath, '.lfsconfig'),
  ];

  for (const filePath of attributeFiles) {
    try {
      const content = await readFile(filePath, 'utf-8');
      if (content.includes('filter=lfs') || content.includes('[lfs]')) {
        return true;
      }
    } catch (error) {
      if (!isEnoent(error)) {
      }
    }
  }

  try {
    const git = simpleGit(repoPath);
    const lsFiles = await git.raw(['ls-files']);
    const sampleFiles = lsFiles.split('\n').filter(Boolean).slice(0, 20);

    if (sampleFiles.length > 0) {
      const checkAttr = await git.raw(['check-attr', 'filter', '--', ...sampleFiles]);
      if (checkAttr.includes('filter: lfs')) {
        return true;
      }
    }
  } catch {}

  return false;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function generateBranchName(): string {
  const name = uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '-',
    length: 2,
    style: 'lowerCase',
  });
  const suffix = randomBytes(3).toString('hex');

  return `${name}-${suffix}`;
}

export async function createWorktree(
  mainRepoPath: string,
  branch: string,
  worktreePath: string,
  startPoint = 'origin/main',
): Promise<void> {
  const usesLfs = await repoUsesLfs(mainRepoPath);

  try {
    const parentDir = join(worktreePath, '..');
    await mkdir(parentDir, { recursive: true });

    const env = await getGitEnv();

    if (usesLfs) {
      const lfsAvailable = await checkGitLfsAvailable(env);
      if (!lfsAvailable) {
        throw new Error(
          `This repository uses Git LFS, but git-lfs was not found. ` +
            `Please install git-lfs (e.g., 'brew install git-lfs') and run 'git lfs install'.`,
        );
      }
    }

    // Resolve startPoint to commit hash to avoid Windows escaping issues with ^{commit}
    const git = simpleGit(mainRepoPath);
    let commitHash: string;
    try {
      commitHash = (await git.revparse([`${startPoint}^{commit}`])).trim();
    } catch {
      // Fallback to local branch if origin/branch doesn't exist
      const localBranch = startPoint.replace(ORIGIN_PREFIX_REGEX, '');
      try {
        commitHash = (await git.revparse([`${localBranch}^{commit}`])).trim();
      } catch {
        commitHash = (await git.revparse([startPoint])).trim();
      }
    }

    await execFileAsync(
      'git',
      ['-C', mainRepoPath, 'worktree', 'add', worktreePath, '-b', branch, commitHash],
      { env, timeout: 120_000 },
    );

    // Git's repository-wide worktree registry has no application owner field. Persist positive,
    // worktree-scoped ownership so boot recovery never mistakes a manual worktree for a Frink one.
    await persistFrinkOwnershipFlag(mainRepoPath, worktreePath, env);

    try {
      await configureWorktreeHooks(mainRepoPath, worktreePath, env);
    } catch (error) {
      await rollbackWorktreeAfterHookFailure(mainRepoPath, worktreePath, branch, env);
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const lowerError = errorMessage.toLowerCase();

    const isLockError =
      lowerError.includes('could not lock') ||
      lowerError.includes('unable to lock') ||
      (lowerError.includes('.lock') && lowerError.includes('file exists'));

    if (isLockError) {
      throw new Error(
        `Failed to create worktree: The git repository is locked by another process. ` +
          `This usually happens when another git operation is in progress, or a previous operation crashed. ` +
          `Please wait for the other operation to complete, or manually remove the lock file ` +
          `(e.g., .git/config.lock or .git/index.lock) if you're sure no git operations are running.`,
      );
    }

    const isLfsError =
      lowerError.includes('git-lfs') ||
      lowerError.includes('filter-process') ||
      lowerError.includes('smudge filter') ||
      (lowerError.includes('lfs') && lowerError.includes('not')) ||
      (lowerError.includes('lfs') && usesLfs);

    if (isLfsError) {
      throw new Error(
        `Failed to create worktree: This repository uses Git LFS, but git-lfs was not found or failed. ` +
          `Please install git-lfs (e.g., 'brew install git-lfs') and run 'git lfs install'.`,
      );
    }
    throw new Error(`Failed to create worktree: ${errorMessage}`);
  }
}

async function rollbackWorktreeAfterHookFailure(
  mainRepoPath: string,
  worktreePath: string,
  branch: string,
  env: Record<string, string>,
): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['-C', mainRepoPath, 'worktree', 'remove', '--force', worktreePath],
      { env, timeout: 120_000 },
    );
  } catch (error) {
    log.warn('[createWorktree] Failed to roll back worktree after hook installation failed', {
      worktreePath,
      error,
    });
    captureContained(error, { surface: 'worktree-hooks', stage: 'creation-rollback' });
    return;
  }

  try {
    await execFileAsync('git', ['-C', mainRepoPath, 'branch', '-D', branch], { env });
  } catch (error) {
    log.warn('[createWorktree] Failed to delete branch after worktree rollback', { branch, error });
    captureContained(error, { surface: 'worktree-hooks', stage: 'branch-rollback' });
  }
}

/** Local branch names we never delete after worktree removal (safety). */
const PROTECTED_WORKTREE_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'trunk', 'head']);

export type RemoveWorktreeOptions = {
  /** If set, delete this local branch after a successful `git worktree remove` (best-effort). */
  branch?: string | null;
};

function shouldDeleteLocalBranchAfterWorktreeRemove(branch: string): boolean {
  const trimmed = branch.trim();
  if (!trimmed) return false;
  return !PROTECTED_WORKTREE_BRANCH_NAMES.has(trimmed.toLowerCase());
}

/**
 * After `removeWorktree` succeeds, delete the worktree's local branch so it does not accumulate.
 * Failures are logged only — callers already completed worktree removal.
 */
async function tryDeleteLocalBranch(mainRepoPath: string, branch: string): Promise<void> {
  if (!shouldDeleteLocalBranchAfterWorktreeRemove(branch)) {
    return;
  }

  const trimmed = branch.trim();
  const env = await getGitEnv();

  try {
    await execFileAsync('git', ['-C', mainRepoPath, 'branch', '-D', trimmed], {
      env,
      timeout: 60_000,
    });
  } catch (error) {
    const stderr =
      isExecFileException(error) && typeof error.stderr === 'string' ? error.stderr : '';
    const msg = error instanceof Error ? error.message : String(error);
    log.warn('[removeWorktree] Local branch delete failed (worktree already removed)', {
      mainRepoPath,
      branch: trimmed,
      stderr: stderr || undefined,
      message: msg,
    });
  }
}

/**
 * Worktree-remove failures worth retrying: a transient OS file handle held by a just-killed
 * terminal/indexer child (releases in ~1-2s). NOT git lockfile errors — those are a different
 * class (`isLockFileError` in git-factory.ts), so `withLockRetry` would no-op here.
 */
const TRANSIENT_WORKTREE_REMOVE_RE =
  /EBUSY|EPERM|ENOTEMPTY|directory not empty|resource busy|being used by another process|permission denied/i;

export function isTransientWorktreeRemoveError(message: string): boolean {
  return TRANSIENT_WORKTREE_REMOVE_RE.test(message);
}

const REMOVE_WORKTREE_MAX_ATTEMPTS = 3;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remove a linked worktree (`git worktree remove --force`).
 * Optionally deletes the associated local branch afterward when `options.branch` is set (sc-562).
 * Worktree removal is the critical path: if branch deletion fails, this still returns `success: true`.
 *
 * Retries the transient handle-held failure class (EBUSY/EPERM/ENOTEMPTY) with backoff — a terminal
 * or detached indexer that was just killed often releases the dir within a beat. The boot-time
 * `recoverOrphanedWorktrees` sweep is the ultimate backstop for whatever still fails here.
 */
export async function removeWorktree(
  mainRepoPath: string,
  worktreePath: string,
  options?: RemoveWorktreeOptions,
): Promise<{ success: boolean; error?: string }> {
  const env = await getGitEnv();
  let lastError = '';

  for (let attempt = 0; attempt < REMOVE_WORKTREE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await execFileAsync(
        'git',
        ['-C', mainRepoPath, 'worktree', 'remove', worktreePath, '--force'],
        { env, timeout: 60_000 },
      );

      const branch = options?.branch;
      if (typeof branch === 'string' && branch.trim().length > 0) {
        await tryDeleteLocalBranch(mainRepoPath, branch);
      }

      return { success: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const canRetry =
        attempt < REMOVE_WORKTREE_MAX_ATTEMPTS - 1 && isTransientWorktreeRemoveError(lastError);
      if (!canRetry) {
        return { success: false, error: lastError };
      }
      await delay(
        computeExponentialBackoffMs(attempt, { baseMs: 300, maxMs: 3_000, jitterMaxMs: 200 }),
      );
    }
  }

  return { success: false, error: lastError };
}

/**
 * `git worktree prune` — clears administrative entries for worktrees whose directories no longer
 * exist on disk (stale registrations). Repo-wide by design, so only call it from the boot sweep
 * (no chat teardown in-flight) — never per-teardown, where a sibling's momentarily-missing dir
 * could be pruned out from under a live fork.
 */
export async function pruneWorktrees(
  mainRepoPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const env = await getGitEnv();
    await execFileAsync('git', ['-C', mainRepoPath, 'worktree', 'prune'], { env, timeout: 60_000 });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type WorktreeInfo = {
  path: string;
  head: string;
  branch: string | null;
  isMain: boolean;
  prunable: boolean;
  detached: boolean;
};

/**
 * Parse the output of `git worktree list --porcelain` into structured WorktreeInfo objects.
 * Shared by listWorktrees and branches.ts's getCheckedOutBranches.
 */
export function parseWorktreeListPorcelain(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split(WORKTREE_BLOCK_SPLIT_REGEX);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;

    const lines = block.split('\n');
    let path = '';
    let head = '';
    let branch: string | null = null;
    let prunable = false;
    let detached = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.substring(9).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.substring(5).trim();
      } else if (line.startsWith('branch ')) {
        branch = line.substring(7).trim().replace('refs/heads/', '');
      } else if (line === 'detached') {
        detached = true;
      } else if (line.startsWith('prunable ') || line === 'prunable') {
        prunable = true;
      }
    }

    if (!path) continue;

    worktrees.push({
      path,
      head,
      branch: detached ? null : branch,
      isMain: i === 0,
      prunable,
      detached,
    });
  }

  return worktrees;
}

/**
 * List all git worktrees for a repository.
 * repoPath can be any path within the repository (main or linked worktree).
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  try {
    const git = simpleGit(repoPath);
    const output = await git.raw(['worktree', 'list', '--porcelain']);
    return parseWorktreeListPorcelain(output);
  } catch {
    return [];
  }
}

async function hasOriginRemote(mainRepoPath: string): Promise<boolean> {
  try {
    const git = simpleGit(mainRepoPath);
    const remotes = await git.getRemotes();
    return remotes.some((r) => r.name === 'origin');
  } catch {
    return false;
  }
}

export async function getDefaultBranch(mainRepoPath: string): Promise<string> {
  const git = simpleGit(mainRepoPath);

  // First check if we have an origin remote
  const hasRemote = await hasOriginRemote(mainRepoPath);

  if (hasRemote) {
    // Try to get the default branch from origin/HEAD
    try {
      const headRef = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      const match = headRef.trim().match(SYMBOLIC_REF_REGEX);
      if (match) return match[1];
    } catch {}

    // Check remote branches for common default branch names
    try {
      const branches = await git.branch(['-r']);
      const remoteBranches = branches.all.map((b) => b.replace('origin/', ''));

      for (const candidate of ['main', 'master', 'develop', 'trunk']) {
        if (remoteBranches.includes(candidate)) {
          return candidate;
        }
      }
    } catch {}

    // Try ls-remote as last resort for remote repos
    try {
      const result = await git.raw(['ls-remote', '--symref', 'origin', 'HEAD']);
      const symrefMatch = result.match(SYMREF_MATCH_REGEX);
      if (symrefMatch) {
        return symrefMatch[1];
      }
    } catch {}
  } else {
    // No remote - use the current local branch or check for common branch names
    try {
      const currentBranch = await getCurrentBranch(mainRepoPath);
      if (currentBranch) {
        return currentBranch;
      }
    } catch {}

    // Fallback: check for common default branch names locally
    try {
      const localBranches = await git.branchLocal();
      for (const candidate of ['main', 'master', 'develop', 'trunk']) {
        if (localBranches.all.includes(candidate)) {
          return candidate;
        }
      }
      // If we have any local branches, use the first one
      if (localBranches.all.length > 0) {
        return localBranches.all[0];
      }
    } catch {}
  }

  return 'main';
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const git = simpleGit(worktreePath);
  const status = await git.status();
  return !status.isClean();
}

export async function hasUnpushedCommits(worktreePath: string): Promise<boolean> {
  const git = simpleGit(worktreePath);
  try {
    const aheadCount = await git.raw(['rev-list', '--count', '@{upstream}..HEAD']);
    return Number.parseInt(aheadCount.trim(), 10) > 0;
  } catch {
    try {
      const localCommits = await git.raw(['rev-list', '--count', 'HEAD', '--not', '--remotes']);
      return Number.parseInt(localCommits.trim(), 10) > 0;
    } catch {
      return false;
    }
  }
}

export type BranchExistsResult =
  | { status: 'exists' }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

/**
 * Git exit codes for ls-remote --exit-code:
 * - 0: Refs found (branch exists)
 * - 2: No matching refs (branch doesn't exist)
 * - 128: Fatal error (auth, network, invalid repo, etc.)
 */
const GIT_EXIT_CODES = {
  SUCCESS: 0,
  NO_MATCHING_REFS: 2,
  FATAL_ERROR: 128,
} as const;

/**
 * Patterns for categorizing git fatal errors (exit code 128).
 * These are checked against lowercase error messages/stderr.
 */
const GIT_ERROR_PATTERNS = {
  network: [
    'could not resolve host',
    'unable to access',
    'connection refused',
    'network is unreachable',
    'timed out',
    'ssl',
    'could not read from remote',
  ],
  auth: [
    'authentication',
    'permission denied',
    '403',
    '401',
    // SSH-specific auth failures
    'permission denied (publickey)',
    'host key verification failed',
  ],
  remoteNotConfigured: [
    'does not appear to be a git repository',
    'no such remote',
    'repository not found',
    'remote origin not found',
  ],
} as const;

function categorizeGitError(errorMessage: string): BranchExistsResult {
  const lowerMessage = errorMessage.toLowerCase();

  if (GIT_ERROR_PATTERNS.network.some((p) => lowerMessage.includes(p))) {
    return {
      status: 'error',
      message: 'Cannot connect to remote. Check your network connection.',
    };
  }

  if (GIT_ERROR_PATTERNS.auth.some((p) => lowerMessage.includes(p))) {
    return {
      status: 'error',
      message: 'Authentication failed. Check your Git credentials.',
    };
  }

  if (GIT_ERROR_PATTERNS.remoteNotConfigured.some((p) => lowerMessage.includes(p))) {
    return {
      status: 'error',
      message: "Remote 'origin' is not configured or the repository was not found.",
    };
  }

  return {
    status: 'error',
    message: `Failed to verify branch: ${errorMessage}`,
  };
}

export async function branchExistsOnRemote(
  worktreePath: string,
  branchName: string,
): Promise<BranchExistsResult> {
  const env = await getGitEnv();

  try {
    // Use execFileAsync directly to get reliable exit codes
    // simple-git doesn't expose exit codes in a predictable way
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'ls-remote', '--exit-code', '--heads', 'origin', branchName],
      { env, timeout: 30_000 },
    );
    // Exit code 0 = branch exists (--exit-code flag ensures this)
    return { status: 'exists' };
  } catch (error) {
    // Use type guard to safely access ExecFileException properties
    if (!isExecFileException(error)) {
      return {
        status: 'error',
        message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Handle spawn/system errors first (code is a string like "ENOENT")
    if (typeof error.code === 'string') {
      if (error.code === 'ENOENT') {
        return {
          status: 'error',
          message: 'Git is not installed or not found in PATH.',
        };
      }
      if (error.code === 'ETIMEDOUT') {
        return {
          status: 'error',
          message: 'Git command timed out. Check your network connection.',
        };
      }
      // Other system errors
      return {
        status: 'error',
        message: `System error: ${error.code}`,
      };
    }

    // Handle killed/timed out processes (timeout option triggers this)
    if (error.killed || error.signal) {
      return {
        status: 'error',
        message: 'Git command timed out. Check your network connection.',
      };
    }

    // Now code is numeric - it's a git exit code
    if (error.code === GIT_EXIT_CODES.NO_MATCHING_REFS) {
      return { status: 'not_found' };
    }

    // For fatal errors (128) or other codes, categorize using stderr (preferred) or message
    // stderr contains the actual git error; message may include wrapper text
    const errorText = error.stderr || error.message || '';
    return categorizeGitError(errorText);
  }
}

/**
 * Detect which branch a worktree was likely based off of.
 * Uses merge-base to find the closest common ancestor with candidate base branches.
 */
export async function detectBaseBranch(
  worktreePath: string,
  currentBranch: string,
  defaultBranch: string,
): Promise<string | null> {
  const git = simpleGit(worktreePath);

  // Candidate base branches to check, in priority order
  const candidates = [defaultBranch, 'main', 'master', 'develop', 'development'].filter(
    (b, i, arr) => arr.indexOf(b) === i,
  ); // dedupe

  let bestCandidate: string | null = null;
  let bestAheadCount: number = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    // Skip if this is the current branch
    if (candidate === currentBranch) continue;

    try {
      // Check if the remote branch exists
      const remoteBranch = `origin/${candidate}`;
      await git.raw(['rev-parse', '--verify', remoteBranch]);

      // Count how many commits the current branch is ahead of the merge-base
      // The branch with the fewest commits "ahead" is likely the base
      const mergeBase = await git.raw(['merge-base', 'HEAD', remoteBranch]);
      const aheadCount = await git.raw(['rev-list', '--count', `${mergeBase.trim()}..HEAD`]);

      const count = Number.parseInt(aheadCount.trim(), 10);
      if (count < bestAheadCount) {
        bestAheadCount = count;
        bestCandidate = candidate;
      }
    } catch {}
  }

  return bestCandidate;
}

/**
 * Gets the current branch name (HEAD)
 * @param repoPath - Path to the repository
 * @returns The current branch name, or null if in detached HEAD state
 */
export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  const git = simpleGit(repoPath);
  try {
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const trimmed = branch.trim();
    // "HEAD" means detached HEAD state
    return trimmed === 'HEAD' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Checks if a git ref exists locally (without network access).
 * Uses --verify --quiet to only check exit code without output.
 * @param repoPath - Path to the repository
 * @param ref - The ref to check (e.g., "main", "origin/main")
 * @returns true if the ref exists locally, false otherwise
 */
async function refExistsLocally(repoPath: string, ref: string): Promise<boolean> {
  const git = simpleGit(repoPath);
  try {
    // Use --verify --quiet to check if ref exists without output
    // Append ^{commit} to ensure it resolves to a commit-ish
    await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// ============ Utility functions for chats.ts compatibility ============

export type WorktreeResult = {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  error?: string;
};

function assertSafeProjectSlug(projectSlug: string): string {
  const trimmed = projectSlug.trim();
  const isSingleSafeSegment =
    trimmed.length > 0 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    !trimmed.includes('..') &&
    !trimmed.includes('/') &&
    !trimmed.includes('\\') &&
    PROJECT_SLUG_SINGLE_SEGMENT_REGEX.test(trimmed);

  if (!isSingleSafeSegment) {
    throw new Error(
      `Invalid project slug "${projectSlug}". Expected a single safe path segment without traversal.`,
    );
  }

  return trimmed;
}

export async function buildChatWorktreePath(
  projectSlug: string,
  projectPath: string,
): Promise<{
  worktreePath: string;
  projectWorktreeDir: string;
}> {
  const safeProjectSlug = assertSafeProjectSlug(projectSlug);
  const detectedConfig = await detectWorktreeConfig(projectPath);
  const projectOverride = detectedConfig.config?.['worktree-base-path'];
  const worktreesDir =
    projectOverride && isSafeConfiguredWorktreeBasePath(projectOverride)
      ? normalizeWorktreeBasePath(projectOverride)
      : await resolveWorktreeBasePath();
  const projectWorktreeDir = join(worktreesDir, safeProjectSlug);
  const folderName = generateWorktreeFolderName(projectWorktreeDir);
  return {
    projectWorktreeDir,
    worktreePath: join(projectWorktreeDir, folderName),
  };
}

/**
 * Create a git worktree for a Start Task flow block.
 *
 * When `branch` is provided: fetches from origin and checks out `origin/<branch>`.
 * When `branch` is omitted: creates a standard worktree from the default branch (same as chat).
 *
 * Setup is awaited (not backgrounded as for chat) and rolled back on failure — see
 * `worktree-setup-command-portability`. Returns `{ success, worktreePath, branch, baseBranch }`.
 */
export async function createWorktreeForBranch(
  projectPath: string,
  projectSlug: string,
  branch?: string,
  signal?: AbortSignal,
): Promise<WorktreeResult> {
  try {
    const git = simpleGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return { success: true, worktreePath: projectPath };
    }

    const { worktreePath } = await buildChatWorktreePath(projectSlug, projectPath);

    const baseBranch = branch || (await getDefaultBranch(projectPath));

    if (branch) {
      const env = await getGitEnv();
      try {
        await execFileAsync('git', ['-C', projectPath, 'fetch', 'origin', branch], {
          env,
          timeout: 60_000,
        });
      } catch {
        // fetch may fail for offline scenarios; proceed and let worktree add fail with a clear error
      }
    }

    const newBranchName = generateBranchName();
    const startPoint = `origin/${baseBranch}`;
    await createWorktree(projectPath, newBranchName, worktreePath, startPoint);
    const setupError = await awaitWorktreeSetup(worktreePath, projectPath, signal);
    if (setupError) {
      await removeWorktree(projectPath, worktreePath, { branch: newBranchName });
      return { success: false, error: setupError };
    }
    return { success: true, worktreePath, branch: newBranchName, baseBranch };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error creating worktree',
    };
  }
}

/**
 * Create a git worktree for a chat (wrapper for chats.ts)
 * @param projectPath - Path to the main repository
 * @param projectSlug - Sanitized project name for worktree directory
 * @param chatId - Chat ID (used for logging)
 * @param selectedBaseBranch - Optional branch to base the worktree off (defaults to auto-detected default branch)
 */
export async function createWorktreeForChat(
  projectPath: string,
  projectSlug: string,
  _chatId: string,
  selectedBaseBranch?: string,
  branchType?: 'local' | 'remote',
): Promise<WorktreeResult> {
  try {
    const git = simpleGit(projectPath);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      return { success: true, worktreePath: projectPath };
    }

    // Use provided base branch or auto-detect
    const baseBranch = selectedBaseBranch || (await getDefaultBranch(projectPath));

    const branch = generateBranchName();
    const { worktreePath } = await buildChatWorktreePath(projectSlug, projectPath);

    // Determine startPoint based on branch type
    // For local branches, use the local ref directly
    // For remote branches or when type is not specified, use origin/{branch}
    const startPoint = branchType === 'local' ? baseBranch : `origin/${baseBranch}`;

    await createWorktree(projectPath, branch, worktreePath, startPoint);

    // Not awaited: the user can start chatting while dependencies install.
    startWorktreeSetup(worktreePath, projectPath);

    return { success: true, worktreePath, branch, baseBranch };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get diff for a worktree compared to its base branch
 * @param worktreePath - Path to the worktree
 * @param baseBranch - The base branch to compare against (if not provided, uses default branch)
 */
export async function getWorktreeDiff(
  worktreePath: string,
  baseBranch?: string,
  options?: { onlyUncommitted?: boolean },
): Promise<{ success: boolean; diff?: string; error?: string }> {
  try {
    const git = simpleGit(worktreePath);
    const status = await git.status();
    const _currentBranch = status.current;

    // Has uncommitted changes - diff against HEAD
    if (!status.isClean()) {
      const exclusionArgs = [
        ':!*.lock',
        ':!*-lock.*',
        ':!package-lock.json',
        ':!pnpm-lock.yaml',
        ':!yarn.lock',
      ];

      const workingDiff = await git.diff(['HEAD', '--no-color', '--', ...exclusionArgs]);

      const untrackedFiles = status.not_added.filter((file) => {
        if (file.endsWith('.lock')) return false;
        if (file.includes('-lock.')) return false;
        if (file.endsWith('package-lock.json')) return false;
        if (file.endsWith('pnpm-lock.yaml')) return false;
        if (file.endsWith('yarn.lock')) return false;
        return true;
      });

      // git diff --no-index only accepts 2 paths, so we need to diff each file separately
      // Also, git diff --no-index returns exit code 1 when files differ, which simple-git treats as error
      // So we use raw() to get the output regardless of exit code
      const untrackedDiffs: string[] = [];
      for (const file of untrackedFiles) {
        try {
          const fileDiff = await git.raw(['diff', '--no-color', '--no-index', devNull, file]);
          if (fileDiff) {
            untrackedDiffs.push(fileDiff);
          }
        } catch (error: unknown) {
          // git diff --no-index returns exit code 1 when files differ
          // simple-git throws but includes the diff output in the error
          const gitError = error as { message?: string };
          if (gitError.message?.includes('diff --git')) {
            // Extract the diff from the error message
            const diffStart = gitError.message.indexOf('diff --git');
            if (diffStart !== -1) {
              untrackedDiffs.push(gitError.message.substring(diffStart));
            }
          }
        }
      }
      const untrackedDiff = untrackedDiffs.join('\n');

      const combinedDiff = [workingDiff, untrackedDiff].filter(Boolean).join('\n');

      return { success: true, diff: combinedDiff };
    }

    // All committed - if onlyUncommitted mode, return empty diff
    if (options?.onlyUncommitted) {
      return { success: true, diff: '' };
    }

    // All committed - diff against base branch
    const targetBranch = baseBranch || (await getDefaultBranch(worktreePath));
    const baseRef = (await refExistsLocally(worktreePath, `origin/${targetBranch}`))
      ? `origin/${targetBranch}`
      : targetBranch;

    try {
      const diff = await git.diff([
        `${baseRef}...HEAD`,
        '--no-color',
        '--',
        ':!*.lock',
        ':!*-lock.*',
        ':!package-lock.json',
        ':!pnpm-lock.yaml',
        ':!yarn.lock',
      ]);
      return { success: true, diff: diff || '' };
    } catch {
      return { success: true, diff: '' };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
