import fs from 'node:fs';
import log from 'electron-log';
import { lookupWorktreeHistoryEntry } from '../db/repos/chats';
import { detectBaseBranch, getCurrentBranch, getDefaultBranch } from './worktree';

export type ResolvedMoveTarget = {
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  /**
   * When the resolver found a history entry whose worktree dir no longer exists, this is
   * the projectId of the stale entry. The helper (`moveChatToProjectLocal`) drops it from
   * history INSIDE its transaction so we don't TOCTOU-overwrite a concurrent move's writes.
   */
  stalePrunedProjectId: string | null;
};

/**
 * Resolve the destination workspace for a chat move. Used by both the DnD path
 * (`chats.moveToProject`) and the MCP path (`requestSwitchProject` cross-project branch) so
 * the policy lives in one place.
 *
 * Branches:
 * 1. `explicitWorktreePath` set (MCP override) → use verbatim; re-derive branch/baseBranch
 *    from disk (mirrors switchWorktree). Forks intentionally share worktrees, so we do NOT
 *    add a `findChatByWorktree` collision check here — pruning would silently break forks.
 * 2. Else `lookupWorktreeHistoryEntry(history, targetProjectId)` returns path AND
 *    path !== targetProjectPath (skip no-op project-root entries) AND fs.existsSync(path)
 *    → restore that worktreePath + re-derive branch.
 * 3. Else fall back to project root: `{ worktreePath: targetProjectPath, branch: null,
 *    baseBranch: null }`. If an entry existed but fs.existsSync was false,
 *    `stalePrunedProjectId` carries the projectId so the helper drops it transactionally.
 */
export async function resolveTargetWorktreeForMove(params: {
  targetProjectId: string | null;
  targetProjectPath: string | null;
  explicitWorktreePath: string | null;
  history: Record<string, string>;
}): Promise<ResolvedMoveTarget> {
  const { targetProjectId, targetProjectPath, explicitWorktreePath, history } = params;

  if (explicitWorktreePath) {
    const { branch, baseBranch } = await deriveGitState(explicitWorktreePath);
    return {
      worktreePath: explicitWorktreePath,
      branch,
      baseBranch,
      stalePrunedProjectId: null,
    };
  }

  if (!targetProjectId) {
    // General Chats: no project, no history lookup, no worktree.
    return { worktreePath: null, branch: null, baseBranch: null, stalePrunedProjectId: null };
  }

  const entry = lookupWorktreeHistoryEntry(history, targetProjectId);
  if (entry && entry !== targetProjectPath) {
    if (fs.existsSync(entry)) {
      const { branch, baseBranch } = await deriveGitState(entry);
      return { worktreePath: entry, branch, baseBranch, stalePrunedProjectId: null };
    }
    // Stale entry — flag projectId for transactional prune so we don't retry next time.
    return {
      worktreePath: targetProjectPath,
      branch: null,
      baseBranch: null,
      stalePrunedProjectId: targetProjectId,
    };
  }

  return {
    worktreePath: targetProjectPath,
    branch: null,
    baseBranch: null,
    stalePrunedProjectId: null,
  };
}

async function deriveGitState(
  worktreePath: string,
): Promise<{ branch: string | null; baseBranch: string | null }> {
  let branch: string | null = null;
  let baseBranch: string | null = null;
  try {
    branch = await getCurrentBranch(worktreePath);
    if (branch) {
      const defaultBranch = await getDefaultBranch(worktreePath);
      baseBranch = await detectBaseBranch(worktreePath, branch, defaultBranch);
    }
  } catch (error) {
    log.warn('[resolveTargetWorktreeForMove] git state read failed:', { worktreePath, error });
  }
  return { branch, baseBranch };
}
