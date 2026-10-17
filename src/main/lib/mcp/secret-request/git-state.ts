import fs from 'node:fs/promises';
import path from 'node:path';
import { createGit } from '../../git/git-factory';
import { isPathCommittable } from '../../git/git-utils';
import type { SecretGitState } from '../../../../shared/types/task-signal';

async function repoTopLevel(cwd: string): Promise<string | null> {
  try {
    return (await createGit(cwd).revparse(['--show-toplevel'])).trim() || null;
  } catch {
    return null;
  }
}

export async function gitStateOf(cwd: string, rel: string): Promise<SecretGitState> {
  if (!(await repoTopLevel(cwd))) return 'none';
  try {
    await createGit(cwd).raw(['ls-files', '--error-unmatch', '--', rel]);
    return 'tracked';
  } catch {
    return (await isPathCommittable(cwd, rel)) ? 'untracked' : 'ignored';
  }
}

/** Ignore `target` on this machine only, via the repo's `info/exclude`; no tracked file changes. */
export async function excludeFromGit(cwd: string, target: string): Promise<void> {
  const top = await repoTopLevel(cwd);
  if (!top) return;
  // `--git-common-dir` is relative (`.git`) in a main checkout and absolute in a worktree.
  const commonDir = path.resolve(cwd, (await createGit(cwd).revparse(['--git-common-dir'])).trim());
  const excludePath = path.join(commonDir, 'info', 'exclude');
  const relToTop = path
    .relative(await fs.realpath(top), target)
    .split(path.sep)
    .join('/');
  // Escaped so `[`, `*`, `?` and backslashes in a folder name match literally, not as globs.
  const line = `/${relToTop.replace(/[\\[\]*?]/g, '\\$&')}`;
  const current = await fs.readFile(excludePath, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).includes(line)) return;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await fs.appendFile(excludePath, `${separator}${line}\n`);
}
