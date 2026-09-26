/**
 * Git module - combines all git-related routers
 * Flattened structure to match Superset API (changes.getStatus, changes.stageFile, etc.)
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  normalizeGitRemoteUrl as _normalizeUrl,
  type GitProvider,
  HTTPS_REPO_REGEX,
  resolveProviderFromHost,
  SSH_REPO_REGEX,
} from '../../../shared/lib/git-url';
import { router } from '../trpc';
import { createBranchesRouter } from './branches';
import { createFileContentsRouter } from './file-contents';
import { createGitOperationsRouter } from './git-operations';
import { createRecentCommitStatsRouter } from './recent-commit-stats';
import { createStagingRouter } from './staging';
import { createStatusRouter } from './status';

const execAsync = promisify(exec);

// Re-export GitHub utilities
export * from './github';
// Re-export worktree utilities
export * from './worktree';
export * from './worktree-naming';

/**
 * Combined git router with flattened procedures
 * This matches Superset's changes router API structure
 */
export const createGitRouter = () => {
  return router({
    // Merge all sub-router procedures at top level
    ...createStatusRouter()._def.procedures,
    ...createStagingRouter()._def.procedures,
    ...createGitOperationsRouter()._def.procedures,
    ...createBranchesRouter()._def.procedures,
    ...createFileContentsRouter()._def.procedures,
    ...createRecentCommitStatsRouter()._def.procedures,
  });
};

// ============ GIT REMOTE INFO ============

export type GitRemoteInfo = {
  remoteUrl: string | null;
  /** Canonical form: `provider/owner/repo` (e.g. `github.com/owner/repo`) */
  normalizedUrl: string | null;
  provider: GitProvider;
  owner: string | null;
  repo: string | null;
};

/**
 * Check if a path is a git repository
 */
async function isGitRepo(path: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a git remote URL to extract provider, owner, and repo
 * Handles both formats and SSH host aliases:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - git@github.com-work:owner/repo.git  (SSH alias)
 */
function parseGitRemoteUrl(url: string): Omit<GitRemoteInfo, 'remoteUrl' | 'normalizedUrl'> {
  // Normalize the URL
  let normalized: string = url.trim();

  // Remove .git suffix
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
  }

  // Match HTTPS format: https://github.com/owner/repo
  const httpsMatch = normalized.match(HTTPS_REPO_REGEX);
  if (httpsMatch) {
    const [, host, ownerPart, repoPart] = httpsMatch;
    const resolved = resolveProviderFromHost(host);
    return {
      provider: resolved?.provider ?? null,
      owner: ownerPart || null,
      repo: repoPart || null,
    };
  }

  // Match SSH format: git@<host>:owner/repo (supports aliases)
  const sshMatch = normalized.match(SSH_REPO_REGEX);
  if (sshMatch) {
    const [, host, ownerPart, repoPart] = sshMatch;
    const resolved = resolveProviderFromHost(host);
    return {
      provider: resolved?.provider ?? null,
      owner: ownerPart || null,
      repo: repoPart || null,
    };
  }

  return { provider: null, owner: null, repo: null };
}

/**
 * Get git remote info for a project path
 * Extracts remote URL, normalized URL, provider (github/gitlab/bitbucket), owner, and repo name
 */
export async function getGitRemoteInfo(projectPath: string): Promise<GitRemoteInfo> {
  const emptyResult: GitRemoteInfo = {
    remoteUrl: null,
    normalizedUrl: null,
    provider: null,
    owner: null,
    repo: null,
  };

  // Check if it's a git repo
  const isRepo = await isGitRepo(projectPath);
  if (!isRepo) {
    return emptyResult;
  }

  try {
    // Get the remote URL for origin
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: projectPath,
    });

    const remoteUrl = stdout.trim();
    if (!remoteUrl) {
      return emptyResult;
    }

    const parsed = parseGitRemoteUrl(remoteUrl);
    const normalizedUrl = _normalizeUrl(remoteUrl);

    return {
      remoteUrl,
      normalizedUrl,
      ...parsed,
    };
  } catch {
    // No remote configured or other error
    return emptyResult;
  }
}
