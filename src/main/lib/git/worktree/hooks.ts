import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import { getGitEnv } from '../shell-env';

const execFileAsync = promisify(execFile);

/** Keep hook dispatch on the checked-out hook body; runner installation is fail-closed. */
export async function configureWorktreeHooks(
  mainRepoPath: string,
  worktreePath: string,
  providedEnv?: Record<string, string>,
): Promise<void> {
  const env = providedEnv ?? (await getGitEnv());
  await synchronizeCheckoutRunner(mainRepoPath, worktreePath, env);
}

async function synchronizeCheckoutRunner(
  mainRepoPath: string,
  worktreePath: string,
  env: Record<string, string>,
): Promise<void> {
  const hooksPath = await readHooksPath(mainRepoPath, env);
  // Unset/empty → default `.git/hooks`, shared with worktrees via the common dir.
  // Absolute → inherited by the worktree.
  if (!hooksPath || isAbsolute(hooksPath)) return;
  const sourceHooksPath = resolve(mainRepoPath, hooksPath);
  const worktreeHooksPath = resolve(worktreePath, hooksPath);

  if (!(await pathExists(worktreeHooksPath))) {
    await copyHooksRunner(mainRepoPath, worktreePath, sourceHooksPath, worktreeHooksPath);
  }

  await clearLegacyOverride(worktreePath, sourceHooksPath, env);
}

async function readHooksPath(repoPath: string, env: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'config', '--get', 'core.hooksPath'],
      { env },
    );
    return stdout.trim();
  } catch {
    // `git config --get` exits non-zero when the key is unset.
    return '';
  }
}

async function copyHooksRunner(
  mainRepoPath: string,
  worktreePath: string,
  sourceHooksPath: string,
  worktreeHooksPath: string,
): Promise<void> {
  if (!isPathInside(mainRepoPath, sourceHooksPath)) {
    throw new Error(`Refusing to copy git hooks from outside the repository: ${sourceHooksPath}`);
  }
  if (!isPathInside(worktreePath, worktreeHooksPath)) {
    throw new Error(`Refusing to copy git hooks outside the worktree: ${worktreeHooksPath}`);
  }

  const temporaryHooksPath = `${worktreeHooksPath}.frink-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const sourceStat = await stat(sourceHooksPath);
    if (!sourceStat.isDirectory()) throw new Error(`${sourceHooksPath} is not a directory`);
    await mkdir(dirname(worktreeHooksPath), { recursive: true });
    await cp(sourceHooksPath, temporaryHooksPath, { recursive: true, force: false });
    await rename(temporaryHooksPath, worktreeHooksPath);
  } catch (error) {
    await discardTemporaryRunner(temporaryHooksPath);
    // Another atomic repair may have won the race after our initial stat.
    if (await pathExists(worktreeHooksPath)) return;
    log.warn(`Failed to copy git hook runner into worktree ${worktreePath}:`, error);
    throw error;
  }
}

async function discardTemporaryRunner(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

async function clearLegacyOverride(
  worktreePath: string,
  sourceHooksPath: string,
  env: Record<string, string>,
): Promise<void> {
  const localHooksPath = await readWorktreeHooksOverride(worktreePath, env);
  if (!localHooksPath) return;
  if (!isAbsolute(localHooksPath) || localHooksPath !== sourceHooksPath) return;
  try {
    await execFileAsync(
      'git',
      [
        '-C',
        worktreePath,
        'config',
        '--worktree',
        '--fixed-value',
        '--unset-all',
        'core.hooksPath',
        sourceHooksPath,
      ],
      { env },
    );
  } catch (error) {
    // A concurrent repair may have removed it after our read. Only that outcome is safe.
    if ((await readWorktreeHooksOverride(worktreePath, env)) !== sourceHooksPath) return;
    throw error;
  }
}

async function readWorktreeHooksOverride(
  worktreePath: string,
  env: Record<string, string>,
): Promise<string | null> {
  return execFileAsync(
    'git',
    ['-C', worktreePath, 'config', '--worktree', '--get', 'core.hooksPath'],
    { env },
  )
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const fromRoot = relative(resolve(rootPath), resolve(candidatePath));
  return (
    Boolean(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}
