/**
 * Security module for changes routers.
 *
 * Security model: the worktree path a caller names is trusted — the user's own
 * machine is the boundary — and every operation is contained within it:
 * - Relative paths are rejected if absolute or traversing ("..")
 * - Writes, reads and deletes are blocked when a symlink escapes the worktree
 *
 * See path-validation.ts header for the full threat model.
 */

export {
  gitCheckoutFile,
  gitCheckoutFiles,
  gitStageAll,
  gitStageFile,
  gitStageFiles,
  gitSwitchBranch,
  gitUnstageAll,
  gitUnstageFile,
  gitUnstageFiles,
} from './git-commands';

export { secureFs } from './secure-fs';
