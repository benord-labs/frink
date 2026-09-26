import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from 'electron-log';
import { getGitEnv } from '../shell-env';

const execFileAsync = promisify(execFile);
const FRINK_MANAGED_WORKTREE_CONFIG_KEY = 'frink.managed';

async function ensureWorktreeConfigEnabled(
  mainRepoPath: string,
  env: Record<string, string>,
): Promise<void> {
  const ext = await execFileAsync(
    'git',
    ['-C', mainRepoPath, 'config', '--local', '--get', 'extensions.worktreeConfig'],
    { env },
  )
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');
  if (ext !== 'true') {
    const coreBare = await execFileAsync(
      'git',
      ['-C', mainRepoPath, 'config', '--local', '--bool', '--get', 'core.bare'],
      { env },
    )
      .then(({ stdout }) => stdout.trim())
      .catch(() => 'false');
    const coreWorktree = await execFileAsync(
      'git',
      ['-C', mainRepoPath, 'config', '--local', '--get', 'core.worktree'],
      { env },
    )
      .then(({ stdout }) => stdout.trim())
      .catch(() => '');
    if (coreBare === 'true' || coreWorktree) {
      throw new Error('Refusing to enable worktree config for a bare/core.worktree repository');
    }

    await execFileAsync(
      'git',
      ['-C', mainRepoPath, 'config', 'extensions.worktreeConfig', 'true'],
      { env },
    );
  }
}

export async function persistFrinkOwnershipFlag(
  mainRepoPath: string,
  worktreePath: string,
  env: Record<string, string>,
): Promise<void> {
  try {
    await ensureWorktreeConfigEnabled(mainRepoPath, env);
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'config', '--worktree', FRINK_MANAGED_WORKTREE_CONFIG_KEY, 'true'],
      { env },
    );
  } catch (error) {
    // Ownership metadata is fail-safe: an unmarked worktree may leak after a failed teardown, but
    // startup recovery will never infer ownership and delete it. Worktree creation still succeeds.
    log.warn(`[createWorktree] Failed to mark worktree as Frink-managed: ${worktreePath}`, error);
  }
}

/**
 * Positive ownership check for destructive boot recovery.
 *
 * `--worktree` deliberately restricts the read to this linked worktree's config. A same-named
 * repository/global value is not ownership, and missing/unreadable metadata always fails safe.
 */
export async function isFrinkManagedWorktree(worktreePath: string): Promise<boolean> {
  try {
    const env = await getGitEnv();
    const { stdout: extension } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'config', '--local', '--bool', '--get', 'extensions.worktreeConfig'],
      { env, timeout: 10_000 },
    );
    if (extension.trim() !== 'true') return false;

    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        worktreePath,
        'config',
        '--worktree',
        '--bool',
        '--get',
        FRINK_MANAGED_WORKTREE_CONFIG_KEY,
      ],
      { env, timeout: 10_000 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
