import type { StatusResult } from 'simple-git';
import type { ChangedFile, FileStatus, GitChangesStatus } from '../../../../shared/changes-types';

function mapGitStatus(gitIndex: string, gitWorking: string): FileStatus {
  if (gitIndex === 'A' || gitWorking === 'A') return 'added';
  if (gitIndex === 'D' || gitWorking === 'D') return 'deleted';
  if (gitIndex === 'R') return 'renamed';
  if (gitIndex === 'C') return 'copied';
  if (gitIndex === '?' || gitWorking === '?') return 'untracked';
  return 'modified';
}

function toChangedFile(path: string, gitIndex: string, gitWorking: string): ChangedFile {
  return {
    path,
    status: mapGitStatus(gitIndex, gitWorking),
  };
}

/** Status plus the checked-out branch from `git status -b`; null when HEAD is detached. */
export type GitStatusWithBranch = GitChangesStatus & { branch: string | null };

export function parseGitStatus(status: StatusResult): GitStatusWithBranch {
  const staged: ChangedFile[] = [];
  const unstaged: ChangedFile[] = [];
  const untracked: ChangedFile[] = [];

  for (const file of status.files) {
    const path = file.path;
    const index = file.index;
    const working = file.working_dir;

    if (index === '?' && working === '?') {
      untracked.push(toChangedFile(path, index, working));
      continue;
    }

    if (index && index !== ' ' && index !== '?') {
      staged.push(toChangedFile(path, index, ' '));
    }

    if (working && working !== ' ' && working !== '?') {
      unstaged.push(toChangedFile(path, ' ', working));
    }
  }

  return {
    // simple-git reports a detached HEAD as the branch name `HEAD`
    branch: status.detached ? null : status.current,
    staged,
    unstaged,
    untracked,
  };
}
