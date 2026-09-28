import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import log from 'electron-log';
import { captureContained } from '../../sentry';

const execFileAsync = promisify(execFile);

// Keeps the worktree when only post-checkout failed: git says a hook can't change the outcome.
// A kill or timeout still fails, since git points HEAD at the branch before checkout runs.
export async function addWorktree(
  mainRepoPath: string,
  worktreePath: string,
  branch: string,
  commitHash: string,
  env: Record<string, string>,
  timeoutMs = 120_000,
): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['-C', mainRepoPath, 'worktree', 'add', worktreePath, '-b', branch, commitHash],
      { env, timeout: timeoutMs },
    );
  } catch (error) {
    const { code, killed, signal, stderr } = error as ExecFileException & { stderr?: string };
    const exitedNormally = typeof code === 'number' && !killed && !signal;
    if (!exitedNormally || !(await isCheckedOutAt(worktreePath, branch, commitHash, env))) {
      throw error;
    }
    log.warn('[createWorktree] A git hook failed after the worktree was created; continuing', {
      worktreePath,
      exitCode: code,
      stderr: stderr?.trim(),
    });
    captureContained(error, { surface: 'worktree-hooks', stage: 'post-checkout-tolerated' });
  }
}

export async function branchExists(
  mainRepoPath: string,
  branch: string,
  env: Record<string, string>,
): Promise<boolean> {
  return execFileAsync(
    'git',
    ['-C', mainRepoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { env },
  ).then(
    () => true,
    () => false,
  );
}

// Undo a failed create (git makes the -b branch before validating the path). Never remove another
// worktree at the path, nor a branch that pre-existed, moved, or is checked out elsewhere.
export async function rollbackCreatedWorktree(
  mainRepoPath: string,
  worktreePath: string,
  branch: string,
  commitHash: string,
  branchPreExisted: boolean,
  env: Record<string, string>,
): Promise<void> {
  if (await hasBranchCheckedOut(worktreePath, branch, env)) {
    try {
      await execFileAsync(
        'git',
        ['-C', mainRepoPath, 'worktree', 'remove', '--force', worktreePath],
        { env, timeout: 120_000 },
      );
    } catch (error) {
      log.warn('[createWorktree] Failed to roll back worktree after creation failed', {
        worktreePath,
        error,
      });
      captureContained(error, { surface: 'worktree-hooks', stage: 'creation-rollback' });
      // The branch is still checked out there; deleting its ref would corrupt that worktree.
      return;
    }
  }

  if (branchPreExisted || !(await branchExists(mainRepoPath, branch, env))) return;
  // A concurrent create of the same name may own it: never delete a branch another worktree has
  // checked out (what `branch -D` refuses too), even though the ref still sits on our commit.
  if (await isCheckedOutAnywhere(mainRepoPath, branch, env)) return;
  try {
    await execFileAsync(
      'git',
      ['-C', mainRepoPath, 'update-ref', '-d', `refs/heads/${branch}`, commitHash],
      { env },
    );
  } catch (error) {
    log.warn('[createWorktree] Failed to delete branch after worktree rollback', { branch, error });
    captureContained(error, { surface: 'worktree-hooks', stage: 'branch-rollback' });
  }
}

async function readHead(
  worktreePath: string,
  env: Record<string, string>,
): Promise<{ head: string; ref: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
      { env, timeout: 10_000 },
    );
    const [head = '', ref = ''] = stdout.trim().split('\n');
    return { head, ref };
  } catch {
    return null;
  }
}

async function hasBranchCheckedOut(
  worktreePath: string,
  branch: string,
  env: Record<string, string>,
): Promise<boolean> {
  return (await readHead(worktreePath, env))?.ref === `refs/heads/${branch}`;
}

async function isCheckedOutAnywhere(
  mainRepoPath: string,
  branch: string,
  env: Record<string, string>,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', mainRepoPath, 'worktree', 'list', '--porcelain'],
      { env },
    );
    return stdout.split('\n').includes(`branch refs/heads/${branch}`);
  } catch {
    return true; // Unknown ownership fails safe: leak the branch rather than delete another's.
  }
}

/** True when the worktree has the new branch checked out at the requested commit. */
async function isCheckedOutAt(
  worktreePath: string,
  branch: string,
  commitHash: string,
  env: Record<string, string>,
): Promise<boolean> {
  const state = await readHead(worktreePath, env);
  return state?.head === commitHash && state.ref === `refs/heads/${branch}`;
}
