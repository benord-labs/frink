import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Check whether a file path is within a project directory.
 * Uses realpath when possible to avoid symlink/canonical path mismatches.
 */
export function isPathWithinProject(filePath: string, projectPath: string): boolean {
  const resolvedPath = nodePath.resolve(projectPath, filePath);
  const resolvedProject = nodePath.resolve(projectPath);
  const normalizedPath = normalizeForPathCheck(resolveToRealPath(resolvedPath));
  const normalizedProject = normalizeForPathCheck(resolveToRealPath(resolvedProject));
  return (
    normalizedPath.startsWith(normalizedProject + nodePath.sep) ||
    normalizedPath === normalizedProject
  );
}

function realPathOrNull(absolutePath: string): string | null {
  try {
    if (!nodeFs.existsSync(absolutePath)) return null;
    return nodeFs.realpathSync.native(absolutePath);
  } catch {
    return null;
  }
}

/**
 * Strip POSIX shell-escaping from a path (`/a/Personal\ and\ learning/b` →
 * `/a/Personal and learning/b`). Drops a backslash that escapes a shell-special
 * char (space, `(`, `&`, …) while leaving `\<wordchar>` and `\/` intact. Never
 * applied on Windows, where `\` is the path separator.
 */
function unescapeShellPath(p: string): string {
  return p.replace(/\\(?=[^\w/])/g, '');
}

export function resolveToRealPath(absolutePath: string): string {
  const real = realPathOrNull(absolutePath);
  if (real !== null) return real;

  // Fallback: the literal path resolves to no real file. An agent will sometimes copy a
  // shell-escaped path (carried over from a prior `cd`/bash command) straight into a file
  // tool's `file_path`; the literal backslashes match nothing on disk, so an in-project
  // read would otherwise be misclassified as external. Retry once with shell-escaping
  // stripped. This can only turn a genuinely in-project (but shell-escaped) path from
  // "outside" to "inside" — realpath still resolves symlinks, so the boundary holds and a
  // path that truly points outside the project stays outside.
  if (process.platform !== 'win32' && absolutePath.includes('\\')) {
    const unescaped = unescapeShellPath(absolutePath);
    if (unescaped !== absolutePath) {
      const realUnescaped = realPathOrNull(unescaped);
      if (realUnescaped !== null) return realUnescaped;
    }
  }

  return absolutePath;
}

function normalizeForPathCheck(targetPath: string): string {
  const normalized = nodePath.normalize(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
