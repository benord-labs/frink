import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { normalizePathSlashes } from '../../../../shared/lib/path-normalization';

type GitDir = {
  path: string;
  /** True for a linked worktree, whose HEAD and index live outside the working tree. */
  outsideWorktree: boolean;
  /** The worktree with symlinks resolved: the watcher reports event paths in this form. */
  worktreeRoot: string;
};

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

/** Whether `relPath`, from `path.relative`, leaves its base directory. */
export function isOutsideRelativePath(relPath: string): boolean {
  return relPath === '..' || relPath.startsWith(`..${path.sep}`) || path.isAbsolute(relPath);
}

const POINTER_FILES = new Set([
  'HEAD',
  'index',
  'packed-refs',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REBASE_HEAD',
]);

/** `filePath` relative to `gitDir`, with forward slashes. */
function relativeToGitDir(gitDir: string, filePath: string): string {
  return normalizePathSlashes(path.relative(gitDir, filePath));
}

/** Whether `filePath` in a worktree's own git dir is a file git status follows: HEAD, the index,
 * an operation head, or a branch or remote ref. */
export function isGitDirPointerFile(gitDir: string, filePath: string): boolean {
  const relPath = relativeToGitDir(gitDir, filePath);
  if (POINTER_FILES.has(relPath)) return true;
  return (
    !relPath.endsWith('.lock') &&
    (relPath.startsWith('refs/heads/') || relPath.startsWith('refs/remotes/'))
  );
}

/** Where `worktreePath` keeps its HEAD, index and refs, or null when it is not a repository. */
export async function resolveGitDir(worktreePath: string): Promise<GitDir | null> {
  const gitDir = await runGit(worktreePath, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return null;
  const worktreeRoot = await realpath(worktreePath).catch(() => worktreePath);
  return {
    path: gitDir,
    outsideWorktree: isOutsideRelativePath(path.relative(worktreeRoot, gitDir)),
    worktreeRoot,
  };
}
