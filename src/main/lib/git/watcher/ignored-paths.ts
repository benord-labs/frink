import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { normalizePathSlashes } from '../../../../shared/lib/path-normalization';
import { isOutsideRelativePath } from './git-dir';

const CACHE_TTL_MS = 60_000;
const MAX_CACHED_PATHS = 10_000;
/** Beyond this a batch is a checkout or an install: status changed anyway, so skip the check. */
const MAX_PATHS_PER_CHECK = 2000;

/** Resolves to the ignored subset of `relPaths`, or null when git could not answer. */
type CheckIgnore = (worktreePath: string, relPaths: string[]) => Promise<Set<string> | null>;

/** One `git check-ignore` for the whole batch; it honours the index, so tracked files never match. */
const runGitCheckIgnore: CheckIgnore = (worktreePath, relPaths) =>
  new Promise((resolve) => {
    const child = execFile(
      'git',
      ['check-ignore', '--stdin', '-z'],
      { cwd: worktreePath, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) {
          resolve(new Set(stdout.split('\0').filter(Boolean)));
          return;
        }
        // Exit 1 means "none of these are ignored"; anything else is a real failure.
        resolve(error.code === 1 ? new Set() : null);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(relPaths.map((relPath) => `${relPath}\0`).join(''));
  });

export type IgnoreFilter = {
  /** The subset of absolute `paths` the repository does not ignore; everything when git fails. */
  keepUnignored: (paths: string[]) => Promise<string[]>;
  /** Forget cached answers, e.g. after a .gitignore or index change. */
  reset: () => void;
};

export function createIgnoreFilter(
  worktreePath: string,
  checkIgnore: CheckIgnore = runGitCheckIgnore,
): IgnoreFilter {
  // Keyed by exact path: a tracked file can sit inside an ignored directory.
  const ignoredByRelPath = new Map<string, boolean>();
  let expiresAt = 0;

  const reset = () => {
    ignoredByRelPath.clear();
  };

  const keepUnignored = async (paths: string[]): Promise<string[]> => {
    const now = Date.now();
    if (now >= expiresAt || ignoredByRelPath.size > MAX_CACHED_PATHS) {
      reset();
      expiresAt = now + CACHE_TTL_MS;
    }

    const relPathByPath = new Map<string, string>();
    for (const filePath of paths) {
      const relative = path.relative(worktreePath, filePath);
      if (!relative || isOutsideRelativePath(relative)) continue;
      relPathByPath.set(filePath, normalizePathSlashes(relative));
    }

    const unknown = Array.from(new Set(relPathByPath.values())).filter(
      (relPath) => !ignoredByRelPath.has(relPath),
    );
    if (unknown.length > MAX_PATHS_PER_CHECK) return paths;
    if (unknown.length > 0) {
      const ignored = await checkIgnore(worktreePath, unknown);
      if (!ignored) return paths;
      for (const relPath of unknown) {
        ignoredByRelPath.set(relPath, ignored.has(relPath));
      }
    }

    return paths.filter((filePath) => {
      const relPath = relPathByPath.get(filePath);
      return relPath === undefined || ignoredByRelPath.get(relPath) !== true;
    });
  };

  return { keepUnignored, reset };
}
