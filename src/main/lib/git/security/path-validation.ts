import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDatabase, projects } from '../../db';

/**
 * Path containment for git file operations.
 *
 * There is no allowlist of "known" workspace paths: the user's own machine is the
 * trust boundary, and a database row proving a path is registered cannot detect the
 * threat that matters here anyway.
 *
 * THREAT MODEL: a repository the user cloned — not the user themselves — can contain
 * symlinks that make a file look in-repo while it reads or writes somewhere else
 * (e.g. `docs/config.yml` → `~/.bashrc`). Containment, not registration, catches that.
 *
 * CONTAINMENT: validateRelativePath()
 * - Rejects absolute paths and ".." traversal segments
 *
 * SYMLINK PROTECTION (secure-fs.ts):
 * - Writes: Block if realpath escapes the worktree the caller named
 * - Reads: Caller can check isSymlinkEscaping() to warn users
 */

/**
 * Security error codes for path validation failures.
 */
type PathValidationErrorCode =
  | 'ABSOLUTE_PATH'
  | 'PATH_TRAVERSAL'
  | 'UNREGISTERED_PROJECT'
  | 'INVALID_TARGET'
  | 'SYMLINK_ESCAPE';

/**
 * Error thrown when path validation fails.
 * Includes a code for programmatic handling.
 */
export class PathValidationError extends Error {
  constructor(
    message: string,
    public readonly code: PathValidationErrorCode,
  ) {
    super(message);
    this.name = 'PathValidationError';
  }
}

/**
 * Options for path validation.
 */
type ValidatePathOptions = {
  /**
   * Allow empty/root path (resolves to worktree itself).
   * Default: false (prevents accidental worktree deletion)
   */
  allowRoot?: boolean;
};

/**
 * Validates a relative file path for safety.
 * Rejects absolute paths and path traversal attempts.
 *
 * @throws PathValidationError if path is invalid
 */
function validateRelativePath(filePath: string, options: ValidatePathOptions = {}): void {
  const { allowRoot = false } = options;

  // Reject absolute paths
  if (isAbsolute(filePath)) {
    throw new PathValidationError('Absolute paths are not allowed', 'ABSOLUTE_PATH');
  }

  const normalized = normalize(filePath);
  const segments = normalized.split(sep);

  // Reject ".." as a path segment (allows "..foo" directories)
  if (segments.includes('..')) {
    throw new PathValidationError('Path traversal not allowed', 'PATH_TRAVERSAL');
  }

  // Reject root path unless explicitly allowed
  if (!allowRoot && (normalized === '' || normalized === '.')) {
    throw new PathValidationError('Cannot target worktree root', 'INVALID_TARGET');
  }
}

/**
 * Validates and resolves a path within a worktree. Sync, simple.
 *
 * @param worktreePath - The worktree base path
 * @param filePath - The relative file path to validate
 * @param options - Validation options
 * @returns The resolved full path
 * @throws PathValidationError if path is invalid
 */
export function resolvePathInWorktree(
  worktreePath: string,
  filePath: string,
  options: ValidatePathOptions = {},
): string {
  validateRelativePath(filePath, options);
  // Use resolve to handle any worktreePath (relative or absolute)
  return resolve(worktreePath, normalize(filePath));
}

/**
 * Validates a project path is registered and returns its local database ID.
 * Combines validation + lookup in one query (avoids discarding the result).
 *
 * @throws PathValidationError if the project is not registered
 */
export function getProjectIdByPath(projectPath: string): string {
  const db = getDatabase();
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.path, projectPath))
    .get();

  if (!project) {
    throw new PathValidationError('Path is not a registered project', 'UNREGISTERED_PROJECT');
  }
  return project.id;
}

/**
 * Validates a path for git commands. Lighter check that allows root.
 *
 * @throws PathValidationError if path is invalid
 */
export function assertValidGitPath(filePath: string): void {
  validateRelativePath(filePath, { allowRoot: true });
}
