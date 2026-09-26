import { normalizePathSlashes } from '../../../../shared/lib/path-normalization';

/** Matches both standard `.git/HEAD` and linked worktree `.git/worktrees/<name>/HEAD`. */
const GIT_WORKTREE_HEAD_RE = /\/\.git(?:\/worktrees\/[^/]+)?\/HEAD$/;
/** Matches `.git/index` in standard and linked worktree layouts. */
const GIT_INDEX_RE = /\/\.git(?:\/worktrees\/[^/]+)?\/index$/;
/**
 * Matches branch refs updated on commit/branch movement in standard repo layout.
 * Linked worktrees typically surface through HEAD/index/packed-refs changes instead.
 */
const GIT_BRANCH_REF_RE = /\/\.git\/refs\/heads\/.+$/;
/**
 * Matches remote refs updated by fetch/pull in standard repo layout.
 * Linked worktrees typically surface through HEAD/index/packed-refs changes instead.
 */
const GIT_REMOTE_REF_RE = /\/\.git\/refs\/remotes\/.+$/;
/** Matches packed refs updates used by some git operations. */
const GIT_PACKED_REFS_RE = /\/\.git\/packed-refs$/;
/** Matches git operation heads used by merge/cherry-pick/rebase flows. */
const GIT_OPERATION_HEAD_RE = /\/\.git\/(?:MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD)$/;

function matchesGitPath(filePath: string, matcher: RegExp): boolean {
  return matcher.test(normalizePathSlashes(filePath));
}

/** Normalizes path separators and checks for git HEAD pointer paths. */
function isGitHeadPath(filePath: string): boolean {
  return matchesGitPath(filePath, GIT_WORKTREE_HEAD_RE);
}

function isGitIndexPath(filePath: string): boolean {
  return matchesGitPath(filePath, GIT_INDEX_RE);
}

function isGitBranchRefPath(filePath: string): boolean {
  return matchesGitPath(filePath, GIT_BRANCH_REF_RE);
}

function isGitRemoteRefPath(filePath: string): boolean {
  return matchesGitPath(filePath, GIT_REMOTE_REF_RE);
}

function isGitPackedRefsPath(filePath: string): boolean {
  return matchesGitPath(filePath, GIT_PACKED_REFS_RE);
}

function isGitOperationHeadPath(filePath: string): boolean {
  return matchesGitPath(filePath, GIT_OPERATION_HEAD_RE);
}

export function isGitPointerRelatedPath(filePath: string): boolean {
  return (
    isGitHeadPath(filePath) ||
    isGitIndexPath(filePath) ||
    isGitBranchRefPath(filePath) ||
    isGitRemoteRefPath(filePath) ||
    isGitPackedRefsPath(filePath) ||
    isGitOperationHeadPath(filePath)
  );
}
