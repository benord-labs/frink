import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Check whether a file path is within a project directory.
 * Uses realpath when possible to avoid symlink/canonical path mismatches.
 */
export function isPathWithinProject(filePath: string, projectPath: string): boolean {
  const resolvedPath = nodePath.resolve(projectPath, filePath);
  const resolvedProject = nodePath.resolve(projectPath);
  const opened = nodePath.isAbsolute(filePath) ? filePath : `${resolvedProject}/${filePath}`;
  if (isProcessRelative(opened)) return false;
  const normalizedPath = normalizeForPathCheck(resolveToRealPath(resolvedPath));
  const normalizedProject = normalizeForPathCheck(resolveToRealPath(resolvedProject));
  return (
    normalizedPath.startsWith(normalizedProject + nodePath.sep) ||
    normalizedPath === normalizedProject
  );
}

// Each process sees its own entries here, so Frink's answer for one is not the agent's.
// Any letter case, as macOS's default disk opens /DEV/fd as /dev/fd.
const PROCESS_RELATIVE = /^\/(?:proc|dev\/fd)(?:\/|$)|^\/dev\/std(?:in|out|err)$/i;
// The most links a path may pass through, as the kernel's own limit.
const MAX_LINKS = 40;

/** Where a link points, or undefined for anything else, including a missing path. */
function linkTarget(file: string): string | undefined {
  try {
    const stat = nodeFs.lstatSync(file, { throwIfNoEntry: false });
    return stat?.isSymbolicLink() ? nodeFs.readlinkSync(file) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when an absolute path, or any link met on the way to it, enters /proc, /dev/fd or a
 * standard stream. Walked step by step, as realpath would follow those links in Frink itself.
 */
export function isProcessRelative(absolutePath: string): boolean {
  if (process.platform === 'win32') return false;
  const todo = absolutePath.split('/').reverse();
  let at = '/';
  let links = 0;
  for (let part = todo.pop(); part !== undefined; part = todo.pop()) {
    if (part === '' || part === '.') continue;
    const step = part === '..' ? nodePath.dirname(at) : nodePath.join(at, part);
    if (PROCESS_RELATIVE.test(step)) return true;
    const target = linkTarget(step);
    if (target === undefined) {
      at = step;
      continue;
    }
    if (++links > MAX_LINKS) return true;
    todo.push(...target.split('/').reverse());
    if (target.startsWith('/')) at = '/';
  }
  return false;
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
