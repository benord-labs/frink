import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import { fetchGitHubPRStatus } from '../../../../git';
import { execWithShellEnv } from '../../../../git/shell-env';
import { publicProcedure, router } from '../../../index';

/**
 * PR merge operations
 * Purpose: Merge PRs via gh CLI
 */
export const prMergeRouter = router({
  /**
   * Merge PR via gh CLI
   * First checks if PR is mergeable, returns helpful error if conflicts exist
   */
  mergePr: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
      }),
    )
    .mutation(async ({ input }) => {
      const chat = await getChatByIdLocal(getDatabase(), input.chatId);

      if (!chat?.worktreePath || !chat?.prNumber) {
        throw new Error('No PR to merge');
      }

      // Check PR mergeability before attempting merge
      const prStatus = await fetchGitHubPRStatus(chat.worktreePath);
      if (prStatus?.pr?.mergeable === 'CONFLICTING') {
        throw new Error(
          'MERGE_CONFLICT: This PR has merge conflicts with the base branch. ' +
            'Please sync your branch with the latest changes from main to resolve conflicts.',
        );
      }

      try {
        await execWithShellEnv(
          'gh',
          ['pr', 'merge', String(chat.prNumber), `--${input.method}`, '--delete-branch'],
          { cwd: chat.worktreePath },
        );
        return { success: true };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to merge PR';

        // Check for conflict-related error messages from gh CLI
        if (
          errorMsg.includes('not mergeable') ||
          errorMsg.includes('merge conflict') ||
          errorMsg.includes('cannot be cleanly created') ||
          errorMsg.includes('CONFLICTING')
        ) {
          throw new Error(
            'MERGE_CONFLICT: This PR has merge conflicts with the base branch. ' +
              'Please sync your branch with the latest changes from main to resolve conflicts.',
          );
        }

        throw new Error(errorMsg);
      }
    }),
});
