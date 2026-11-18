import path from 'node:path';
import { gitAsTestUser as git } from './git-as-test-user';

/** A repo with one empty commit and a linked worktree, both under `tmpRoot`. */
export function repoWithWorktree(tmpRoot: string) {
  const repo = path.join(tmpRoot, 'repo');
  git(tmpRoot, 'init', '-q', repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = path.join(tmpRoot, 'worktrees', 'feature');
  git(repo, 'worktree', 'add', '-q', worktree);
  return { repo, worktree };
}
