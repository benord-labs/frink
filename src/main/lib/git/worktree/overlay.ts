import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat, symlink, unlink } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import { isPathInside } from './path-guards';

const execFileAsync = promisify(execFile);

/** Shallowest ignored, untracked strict ancestor of the hooks dir (devkit's `.devkit/`).
 *  Never the hooks dir itself: husky's `.husky/_` keeps its runner copy (story #1563). */
export async function findIgnoredOverlay(
  mainRepoPath: string,
  sourceHooksPath: string,
  env: Record<string, string>,
): Promise<string | null> {
  if (!isPathInside(mainRepoPath, sourceHooksPath)) return null;
  const segments = relative(resolve(mainRepoPath), resolve(sourceHooksPath)).split(sep);
  for (let depth = 1; depth < segments.length; depth++) {
    const candidate = segments.slice(0, depth).join('/');
    if (!(await isIgnored(mainRepoPath, candidate, env))) continue;
    if (await hasTrackedFiles(mainRepoPath, candidate, env)) return null;
    return (await isDirectory(resolve(mainRepoPath, candidate))) ? candidate : null;
  }
  return null;
}

/** Link a missing `<worktree>/<overlay>` to main's. Anything already there is never touched:
 *  an older partial copy only gets a warning naming the manual fix. Returns false when the
 *  caller should fall back to copying the hook runner instead. */
export async function linkOverlay(
  mainRepoPath: string,
  worktreePath: string,
  overlay: string,
  env: Record<string, string>,
): Promise<boolean> {
  const target = resolve(mainRepoPath, overlay);
  const linkPath = resolve(worktreePath, overlay);
  if (!isPathInside(worktreePath, linkPath)) {
    throw new Error(`Refusing to link a hook overlay outside the worktree: ${linkPath}`);
  }
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    // symlink(2) never replaces an existing entry, so its EEXIST is the only existence check.
    // Windows directory symlinks need admin rights; junctions do not and take absolute targets.
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await linksTo(linkPath, target)) return true;
    log.warn(
      `Hook overlay ${linkPath} is not a link to ${target}; gates may miss its baselines. ` +
        `If it only holds a stale hooks copy, replace it with a link to ${target}.`,
    );
    return true;
  }
  // A dir-only exclude (`.devkit/`, devkit before sc-4157) never matches a link, so the link
  // would show as untracked and could be committed. Withdraw only the link this call made.
  if (await isIgnored(worktreePath, overlay, env)) return true;
  log.warn(
    `Hook overlay ${overlay} is excluded only as a directory, so a link would be untracked; ` +
      `copying the hook runner instead. Exclude \`${overlay}\` without a trailing slash to link it.`,
  );
  await unlink(linkPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return false;
}

async function isIgnored(
  repoPath: string,
  path: string,
  env: Record<string, string>,
): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'check-ignore', '-q', '--', path], { env });
    return true;
  } catch (error) {
    // Exit 1 is "not ignored"; anything else keeps the plain runner copy rather than linking.
    if ((error as { code?: unknown }).code !== 1) {
      log.warn(`git check-ignore failed for ${path} in ${repoPath}:`, error);
    }
    return false;
  }
}

async function hasTrackedFiles(
  repoPath: string,
  path: string,
  env: Record<string, string>,
): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'ls-files', '-z', '--', path], {
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.length > 0;
}

async function linksTo(path: string, target: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return false;
    return (await realpath(path)) === (await realpath(target));
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
}
