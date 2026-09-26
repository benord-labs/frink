/* eslint-disable max-lines, max-lines-per-function */
/**
 * Converging merge logic for Start Task flow blocks with multiple dependency branches.
 *
 * When trigger_context.baseBranches (from sc-611 resolveDependencyBranches) contains 2+ entries,
 * the converging stage must incorporate code from ALL dependency branches:
 *   1. Create a worktree based on baseBranches[0] (most-recently-completed dependency).
 *   2. Pre-validate remaining merges using `git merge-tree --write-tree` (Git 2.38+).
 *   3. If all dry-runs pass, execute real merges sequentially.
 *   4. On conflict: report details without dirtying the worktree.
 *
 * Fallback: Git < 2.38 falls back to real merge + detect conflict + `git merge --abort`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from 'electron-log';
import { withGitLock } from './git-factory';
import { getGitEnv } from './shell-env';
import { buildChatWorktreePath, createWorktree, generateBranchName } from './worktree';

const execFileAsync = promisify(execFile);

const GIT_VERSION_REGEX = /git version (\d+)\.(\d+)/;
const MERGE_TREE_CONFLICT_LINE_REGEX = /^CONFLICT\s*\([^)]+\):\s*(.+)/;
const MERGE_TREE_CONFLICT_PATH_REGEX = /Merge conflict in (.+)$/;

/**
 * Check whether the installed Git supports `git merge-tree --write-tree`.
 * The flag was introduced in Git 2.38.0 (Oct 2022).
 */
async function supportsInMemoryMergeTree(env: Record<string, string>): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { env, timeout: 10_000 });
    const match = GIT_VERSION_REGEX.exec(stdout.trim());
    if (!match) return false;
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    return major > 2 || (major === 2 && minor >= 38);
  } catch {
    return false;
  }
}

/**
 * Parse conflicted file paths from `git merge-tree --write-tree` output.
 * The output starts with the merged tree SHA on the first line, followed by
 * conflict notices in the format: "CONFLICT (<type>): <detail>".
 */
function parseMergeTreeConflicts(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split('\n')) {
    const match = MERGE_TREE_CONFLICT_LINE_REGEX.exec(line.trim());
    if (match) {
      // Lines like "Merge conflict in path/to/file" — extract the path
      const detail = match[1];
      const pathMatch = MERGE_TREE_CONFLICT_PATH_REGEX.exec(detail);
      if (pathMatch) {
        files.push(pathMatch[1].trim());
      } else {
        files.push(detail.trim());
      }
    }
  }
  return files;
}

/**
 * Detect conflicted files using `git diff --name-only --diff-filter=U` after a real merge left
 * the index in MERGING state. Used as fallback for Git < 2.38.
 */
async function getConflictedFilesFromIndex(
  worktreePath: string,
  env: Record<string, string>,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'diff', '--name-only', '--diff-filter=U'],
      { env, timeout: 30_000 },
    );
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export type ConvMergeWorktreeResult =
  | {
      success: true;
      worktreePath: string;
      branch: string;
      baseBranch: string;
      mergedBranches: string[];
    }
  | {
      success: false;
      error: string;
    }
  | {
      success: false;
      conflict: true;
      conflictingBranch: string;
      conflictedFiles: string[];
      /** Branches successfully merged before the conflict was detected */
      mergedBranches: string[];
      worktreePath: string;
      branch: string;
      baseBranch: string;
    };

/**
 * Create a git worktree and sequentially merge multiple dependency branches.
 *
 * Used when trigger_context.baseBranches has 2+ entries (converging CEO-DAG stage).
 *
 * Lock strategy:
 *   - withGitLock(projectPath) for git fetch + git worktree add (shared .git metadata)
 *   - withGitLock(projectPath) again to fetch all additional dependency branches (no nesting)
 *   - withGitLock(worktreePath) for merge-tree dry-runs and real merges (worktree-local only)
 *
 * Conflict strategy:
 *   - Git >= 2.38: `git merge-tree --write-tree` for in-memory dry-run (no worktree state change).
 *   - Git <  2.38: real merge + detect conflict + `git merge --abort` as fallback.
 */
export async function createWorktreeWithMergedBases(
  projectPath: string,
  projectSlug: string,
  baseBranches: [string, string, ...string[]],
): Promise<ConvMergeWorktreeResult> {
  const primaryBase = baseBranches[0];
  const additionalBases = baseBranches.slice(1);

  const env = await getGitEnv();
  const useInMemory = await supportsInMemoryMergeTree(env);

  if (!useInMemory) {
    log.warn(
      '[worktree-converge] Git < 2.38 detected; falling back to merge+abort conflict strategy. ' +
        'Upgrade to Git 2.38+ for in-memory pre-validation.',
    );
  }

  // --- Phase 1: fetch primary base + worktree add (serialized on projectPath) ---
  let worktreePath: string;
  let newBranchName: string;
  try {
    const result = await withGitLock(projectPath, async () => {
      // Fetch the primary base branch
      try {
        await execFileAsync('git', ['-C', projectPath, 'fetch', 'origin', primaryBase], {
          env,
          timeout: 60_000,
        });
      } catch (fetchErr) {
        throw new Error(
          `dependency_branch_not_found: Failed to fetch origin/${primaryBase}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        );
      }

      const { worktreePath: wt } = await buildChatWorktreePath(projectSlug, projectPath);
      const branchName = generateBranchName();
      await createWorktree(projectPath, branchName, wt, `origin/${primaryBase}`);
      return { worktreePath: wt, branchName };
    });
    worktreePath = result.worktreePath;
    newBranchName = result.branchName;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error creating worktree',
    };
  }

  // --- Phase 2: fetch all additional dependency branches under projectPath only (avoids
  // nesting projectPath lock inside worktreePath lock) ---
  try {
    await withGitLock(projectPath, async () => {
      for (const depBranch of additionalBases) {
        try {
          await execFileAsync('git', ['-C', projectPath, 'fetch', 'origin', depBranch], {
            env,
            timeout: 60_000,
          });
        } catch (fetchErr) {
          throw new Error(
            `dependency_branch_not_found: Failed to fetch origin/${depBranch}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          );
        }
      }
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error fetching dependency branches',
    };
  }

  // --- Phase 3: validate/merge additional bases (serialized on worktreePath only) ---
  return withGitLock(worktreePath, async () => {
    const mergedBranches: string[] = [];

    for (const depBranch of additionalBases) {
      const remoteRef = `origin/${depBranch}`;

      if (useInMemory) {
        // Pre-validate merge using git merge-tree --write-tree (Git 2.38+).
        // Exit code 0 = clean, 1 = conflicts. stdout starts with tree SHA, then CONFLICT lines.
        let mergeTreeOutput = '';
        let mergeTreeExitCode = 0;
        try {
          const out = await execFileAsync(
            'git',
            ['-C', worktreePath, 'merge-tree', '--write-tree', 'HEAD', remoteRef],
            { env, timeout: 60_000 },
          );
          mergeTreeOutput = out.stdout;
        } catch (err) {
          // execFileAsync throws on non-zero exit for merge-tree
          const e = err as { stdout?: string; code?: number };
          mergeTreeExitCode = typeof e.code === 'number' ? e.code : 1;
          mergeTreeOutput = e.stdout ?? '';
        }

        if (mergeTreeExitCode !== 0) {
          const conflictedFiles = parseMergeTreeConflicts(mergeTreeOutput);
          return {
            success: false,
            conflict: true,
            conflictingBranch: depBranch,
            conflictedFiles,
            mergedBranches,
            worktreePath,
            branch: newBranchName,
            baseBranch: primaryBase,
          };
        }

        // Dry-run passed — execute the real merge
        // Note: a force-push race can cause the real merge to conflict even after a clean dry-run.
        // Wrap in try/catch so this surfaces as a structured conflict result, not a thrown error.
        try {
          await execFileAsync(
            'git',
            [
              '-C',
              worktreePath,
              'merge',
              remoteRef,
              '--no-edit',
              '-m',
              `Merge ${depBranch} (dependency branch) into converging worktree`,
            ],
            { env, timeout: 120_000 },
          );
        } catch {
          // The dry-run may have been stale (branch force-pushed) — treat non-zero real merge
          // identically to the fallback path: detect conflicted files, abort, return conflict.
          const conflictedFiles = await getConflictedFilesFromIndex(worktreePath, env);
          try {
            await execFileAsync('git', ['-C', worktreePath, 'merge', '--abort'], {
              env,
              timeout: 30_000,
            });
          } catch (abortErr) {
            log.warn('[worktree-converge] git merge --abort failed (post-race)', {
              worktreePath,
              abortErr,
            });
          }
          return {
            success: false,
            conflict: true,
            conflictingBranch: depBranch,
            conflictedFiles,
            mergedBranches,
            worktreePath,
            branch: newBranchName,
            baseBranch: primaryBase,
          };
        }
      } else {
        // Fallback path (Git < 2.38): attempt real merge, detect conflict, abort if needed.
        let realMergeExitCode = 0;
        try {
          await execFileAsync(
            'git',
            [
              '-C',
              worktreePath,
              'merge',
              remoteRef,
              '--no-edit',
              '-m',
              `Merge ${depBranch} (dependency branch) into converging worktree`,
            ],
            { env, timeout: 120_000 },
          );
        } catch (err) {
          const e = err as { code?: number };
          realMergeExitCode = typeof e.code === 'number' ? e.code : 1;
        }

        if (realMergeExitCode !== 0) {
          const conflictedFiles = await getConflictedFilesFromIndex(worktreePath, env);
          // Abort to leave the worktree in a clean state
          try {
            await execFileAsync('git', ['-C', worktreePath, 'merge', '--abort'], {
              env,
              timeout: 30_000,
            });
          } catch (abortErr) {
            log.warn('[worktree-converge] git merge --abort failed', { worktreePath, abortErr });
          }
          return {
            success: false,
            conflict: true,
            conflictingBranch: depBranch,
            conflictedFiles,
            mergedBranches,
            worktreePath,
            branch: newBranchName,
            baseBranch: primaryBase,
          };
        }
      }

      mergedBranches.push(depBranch);
    }

    return {
      success: true,
      worktreePath,
      branch: newBranchName,
      baseBranch: primaryBase,
      mergedBranches,
    };
  });
}
