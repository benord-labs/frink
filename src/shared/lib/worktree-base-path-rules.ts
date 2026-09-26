import { normalizePathSlashes, trimTrailingSlashes } from './path-normalization';
import { SENSITIVE_HOME_PATHS, SENSITIVE_UNIX_PREFIXES } from './worktree-sensitive-paths';

/**
 * Worktree base-path rules as a pure, Node-free mirror of the main-process validator.
 *
 * WHY THIS EXISTS: the renderer needs to refuse a path the backend will refuse, but it cannot
 * import `src/main/lib/worktree/base-path-validation.ts` (that module needs `node:os` for the
 * home directory and `node:path` for canonicalization). Without this mirror the settings form
 * hand-rolls its own weaker rules and shows a green field for paths the save then rejects.
 *
 * AUTHORITY: `src/main/lib/worktree/base-path-validation.ts` remains the source of truth — it
 * gates every worktree mkdir and the boot-time config read. This module is a pre-check only.
 *
 * DIRECTION OF SAFETY: this may be STRICTER than the backend, never LOOSER. A looser verdict
 * paints a field valid that the save will refuse — the defect this module was written to remove.
 * The parity test in `base-path-validation.test.ts` pins the direction that matters by checking
 * every path this module ACCEPTS against the backend; asserting the reverse would leave the
 * looseness case unchecked. The one deliberate strictness today is win32 `/etc`.
 *
 * NO NODE BUILTINS. `src/shared` compiles into both processes and the renderer's node-builtin
 * eslint ban is scoped to `src/renderer/**`, so nothing lints this file — purity is discipline.
 * Everything below works in forward-slash space; a Windows `C:\x` normalizes to `C:/x` first.
 */

export type WorktreeBasePathVerdict = 'not-absolute' | 'sensitive' | 'unknown' | null;

export type WorktreeBasePathContext = {
  /**
   * The user's home directory. Absent while the lookup is still in flight, which yields
   * `'unknown'` rather than `null` — reporting "valid" on an unverifiable path is the exact
   * hole this module closes.
   */
  homeDir?: string;
  platform: 'win32' | 'posix';
};

const WINDOWS_DRIVE_ROOT_REGEX = /^([A-Za-z]:)\//;
const LEADING_SLASHES_REGEX = /^\/+/;

function isAbsolutePath(inputPath: string, platform: 'win32' | 'posix'): boolean {
  // Mirrors path.isAbsolute: win32 accepts a drive root AND a bare leading slash
  // (drive-relative), posix only the leading slash. `C:` without a slash is drive-relative
  // on both, hence the trailing `/` in the drive pattern.
  if (inputPath.startsWith('/')) return true;
  return platform === 'win32' && WINDOWS_DRIVE_ROOT_REGEX.test(inputPath);
}

function splitRoot(inputPath: string, platform: 'win32' | 'posix'): [root: string, rest: string] {
  const drive = platform === 'win32' ? WINDOWS_DRIVE_ROOT_REGEX.exec(inputPath) : null;
  if (drive) {
    return [`${drive[1]}/`, inputPath.slice(drive[0].length)];
  }
  // Only absolute paths reach here, so anything without a drive letter opens with a slash.
  // Leading `//` collapses to `/`, matching path.posix.resolve('//server/share') === '/server/share'.
  // path.win32.resolve preserves UNC instead, but the verdict is identical either way: a UNC share
  // matches no sensitive prefix before or after the collapse.
  return ['/', inputPath.replace(LEADING_SLASHES_REGEX, '')];
}

/**
 * Collapse `.`, `..`, and duplicate separators the way Node's posix `normalizeString` does.
 * Popping an empty stack is a no-op, which is what clamps `/..` at the root instead of
 * escaping above it — the slip that would make this check looser than the backend.
 */
function collapseSegments(rest: string): string {
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Reduce the caller's home directory to a join-safe prefix, or `null` when there is no usable
 * value. A blank string is a home directory we do not have, not one at the filesystem root —
 * conflating the two would silently un-check every home-relative secret.
 *
 * A root home directory (`/`, real for daemon and container accounts) reduces to `''` so that
 * `${home}/.ssh` stays single-slashed; the standalone form adds the `/` back via `|| '/'`.
 */
function resolveHomeDir(homeDir: string | undefined): string | null {
  const trimmed = homeDir?.trim();
  if (!trimmed) return null;
  return trimTrailingSlashes(normalizePathSlashes(trimmed));
}

function expandHome(inputPath: string, home: string | null): string | null {
  if (inputPath !== '~' && !inputPath.startsWith('~/')) {
    return inputPath;
  }
  if (home === null) return null;
  return inputPath === '~' ? home || '/' : `${home}/${inputPath.slice(2)}`;
}

function isSensitiveUnixPath(resolvedPath: string, root: string): boolean {
  if (resolvedPath === root || resolvedPath === '/') return true;
  return SENSITIVE_UNIX_PREFIXES.some(
    (prefix) => resolvedPath === prefix || resolvedPath.startsWith(`${prefix}/`),
  );
}

function isSensitiveHomePath(resolvedPath: string, home: string): boolean {
  if (resolvedPath === (home || '/') || resolvedPath === `${home}/.frink`) {
    return true;
  }
  // Case-SENSITIVE on purpose: the backend compares exactly, so it accepts `~/.SSH` on a
  // case-insensitive filesystem. Matching case-insensitively here would block in the UI a
  // path the save would allow — worse than the mismatch being fixed. Do not "fix" this.
  return SENSITIVE_HOME_PATHS.some(
    (name) => resolvedPath === `${home}/${name}` || resolvedPath.startsWith(`${home}/${name}/`),
  );
}

/**
 * Decide whether a worktree base path should be refused before it is submitted.
 *
 * Returns `null` when the path is acceptable, `'unknown'` when `homeDir` is not yet available
 * and the answer therefore cannot be trusted, and otherwise the reason for refusal. An empty
 * input is `null`; each surface decides what "no value" means for itself.
 */
export function checkWorktreeBasePath(
  inputPath: string,
  { homeDir, platform }: WorktreeBasePathContext,
): WorktreeBasePathVerdict {
  const trimmed = normalizePathSlashes(inputPath).trim();
  if (trimmed.length === 0) return null;

  const home = resolveHomeDir(homeDir);
  const expanded = expandHome(trimmed, home);
  if (expanded === null) return 'unknown';
  if (!isAbsolutePath(expanded, platform)) return 'not-absolute';

  const [root, rest] = splitRoot(expanded, platform);
  const collapsed = collapseSegments(rest);
  const resolvedPath = collapsed === '' ? root : `${root}${collapsed}`;

  if (isSensitiveUnixPath(resolvedPath, root)) return 'sensitive';
  // Home-relative secrets are unknowable without the home directory. Reaching here with an
  // absolute path and no home directory means "not provably safe", not "safe".
  if (home === null) return 'unknown';
  return isSensitiveHomePath(resolvedPath, home) ? 'sensitive' : null;
}

/** User-facing copy for a refusal. `null`/`'unknown'` have no message — the field stays quiet. */
export function worktreeBasePathErrorMessage(verdict: WorktreeBasePathVerdict): string | null {
  if (verdict === 'not-absolute') return 'Path must be an absolute path.';
  if (verdict === 'sensitive') return 'Please choose a more specific directory for worktrees.';
  return null;
}
