import { createGit, withLockRetry } from '../git-factory';

/**
 * Switch to a branch.
 *
 * Uses `git switch` (unambiguous branch operation, git 2.23+).
 * Falls back to `git checkout <branch>` for older git versions.
 *
 * Note: `git checkout -- <branch>` is WRONG - that's file checkout syntax.
 */
export async function gitSwitchBranch(worktreePath: string, branch: string): Promise<void> {
  // Validate: reject anything that looks like a flag
  if (branch.startsWith('-')) {
    throw new Error('Invalid branch name: cannot start with -');
  }

  // Validate: reject empty branch names
  if (!branch.trim()) {
    throw new Error('Invalid branch name: cannot be empty');
  }

  const git = createGit(worktreePath);

  await withLockRetry(worktreePath, async () => {
    try {
      // Prefer `git switch` - unambiguous branch operation (git 2.23+)
      await git.raw(['switch', branch]);
    } catch (switchError) {
      // Check if it's because `switch` command doesn't exist (old git < 2.23)
      // Git outputs: "git: 'switch' is not a git command. See 'git --help'."
      const errorMessage = String(switchError);
      if (errorMessage.includes('is not a git command')) {
        // Fallback for older git versions
        // Note: checkout WITHOUT -- is correct for branches
        await git.checkout(branch);
      } else {
        throw switchError;
      }
    }
  });
}
