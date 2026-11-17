/**
 * Types for the git changes/diff viewer feature
 */

/** File status from git, matching short format codes */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';

/** A changed file entry */
export type ChangedFile = {
  path: string; // Relative path from repo root
  status: FileStatus;
};

/** Full git changes status for a worktree */
export type GitChangesStatus = {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
};

/** Parsed diff file for the diff viewer */
export type ParsedDiffFile = {
  /**
   * Stable, case-sensitive identifier for this parsed diff block.
   * Format: `${oldPath}->${newPath}` (may include `/dev/null` for added/deleted files),
   * with fallback `file-<index>` when paths are unavailable.
   * Non-null and unique within a single parsed diff response.
   */
  key: string;
  oldPath: string;
  newPath: string;
  diffText: string;
  isBinary: boolean;
  additions: number;
  deletions: number;
  isValid: boolean;
  fileLang: string | null;
  isNewFile: boolean;
  isDeletedFile: boolean;
};

/** A contiguous changed line range (1-based, inclusive start and inclusive end) */
export type WorkingFileLineChangeRange = {
  /** The change category for this range */
  type: 'added' | 'modified' | 'deleted';
  /** First changed line number (1-based) */
  startLine: number;
  /** Last changed line number (1-based, inclusive) */
  endLine: number;
};

/** Line-level diff marker response for a single file (working tree vs HEAD) */
export type WorkingFileLineChangesResponse = {
  /** Changed line ranges to decorate in the editor */
  ranges: WorkingFileLineChangeRange[];
  /** True when line-level changes cannot be provided for this file */
  unsupported: boolean;
};
