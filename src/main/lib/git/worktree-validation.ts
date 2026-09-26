/**
 * Worktree validation utility for execution context reuse.
 * Called before reusing an existing worktree in trigger_worktree or run_command modes.
 */

import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import simpleGit from 'simple-git';

const GIT_DIR_REF_RE = /^gitdir:\s*(.+)/;

export type WorktreeValidationResult =
  | { valid: true }
  | { valid: false; reason: string; permanent: boolean };

/**
 * Checks whether a worktree path can be safely reused by a flow step.
 *
 * Validates:
 * 1. Path exists on disk
 * 2. Is a valid git worktree (registered in the main repo)
 * 3. No in-progress rebase / merge / cherry-pick
 * 4. No concurrent worktree lock (`.git/index.lock`)
 *
 * Invalid results carry `permanent`: true means the failure is deterministic (path gone,
 * not a worktree) and retrying cannot fix it — callers should fail fast. False means
 * another process may be mid-operation (lock, rebase) and a bounded retry is reasonable.
 *
 * @param worktreePath - Absolute path to the worktree directory
 */
export async function validateWorktreeForReuse(
  worktreePath: string,
): Promise<WorktreeValidationResult> {
  // 1. Path must exist
  try {
    const stats = await stat(worktreePath);
    if (!stats.isDirectory()) {
      return {
        valid: false,
        reason: `Worktree path is not a directory: ${worktreePath}`,
        permanent: true,
      };
    }
  } catch {
    return {
      valid: false,
      reason: `Worktree path does not exist: ${worktreePath}`,
      permanent: true,
    };
  }

  // 2. Must be a git worktree (has a .git file, not a .git directory)
  try {
    const gitFile = join(worktreePath, '.git');
    const gitStats = await stat(gitFile);
    // A worktree has a .git file (pointing to the main repo); the main repo has a .git directory
    if (gitStats.isDirectory()) {
      return {
        valid: false,
        reason: `Path is a main repository, not a worktree: ${worktreePath}`,
        permanent: true,
      };
    }
  } catch {
    return {
      valid: false,
      reason: `Not a git repository (no .git file): ${worktreePath}`,
      permanent: true,
    };
  }

  // 3. Check for in-progress git operations
  const gitDir = join(worktreePath, '.git');
  // The .git file in a worktree contains a path to the actual git dir
  let actualGitDir = gitDir;
  try {
    const content = await readFile(gitDir, 'utf-8');
    const match = content.match(GIT_DIR_REF_RE);
    if (match?.[1]) {
      actualGitDir = match[1].trim();
    }
  } catch {
    // Leave as-is if we can't resolve
  }

  const inProgressMarkers = [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
  ];

  for (const marker of inProgressMarkers) {
    try {
      await access(join(actualGitDir, marker));
      return {
        valid: false,
        reason: `Worktree has an in-progress git operation (${marker}). Complete or abort it first.`,
        permanent: false,
      };
    } catch {
      // Not present — good
    }
  }

  // 4. Check for index lock (another git process is running)
  try {
    await access(join(actualGitDir, 'index.lock'));
    return {
      valid: false,
      reason:
        'Worktree is locked by another git process (index.lock exists). Wait for it to complete.',
      permanent: false,
    };
  } catch {
    // Not locked — good
  }

  // 5. Verify it's recognized as a valid worktree via simple-git status
  try {
    const git = simpleGit(worktreePath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return {
        valid: false,
        reason: `Not a valid git repository: ${worktreePath}`,
        permanent: false,
      };
    }
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to check git status: ${err instanceof Error ? err.message : String(err)}`,
      permanent: false,
    };
  }

  return { valid: true };
}
