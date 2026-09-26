import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import { getWorktreeDiff } from '../../../../git';
import { type ParsedDiffFile, splitUnifiedDiffByFile } from '../../../../git/diff-parser';
import { publicProcedure, router } from '../../../index';
import { buildHeuristicCommitMessage } from './heuristic-commit-message';

/** Commit message generation, derived from the worktree diff. */
export const commitMessageRouter = router({
  /** Generate a commit message from the chat's worktree diff, limited to `filePaths` when given. */
  generateCommitMessage: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        filePaths: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const chat = await getChatByIdLocal(getDatabase(), input.chatId);

      if (!chat?.worktreePath) {
        throw new Error('No worktree path');
      }

      // Get the diff to understand what changed
      const result = await getWorktreeDiff(chat.worktreePath, chat.baseBranch ?? undefined);

      if (!result.success || !result.diff) {
        throw new Error('Failed to get diff');
      }

      // Parse diff to get file list
      let files: ParsedDiffFile[] = splitUnifiedDiffByFile(result.diff);

      // Filter to only selected files if filePaths provided
      if (input.filePaths && input.filePaths.length > 0) {
        const selectedPaths = new Set(input.filePaths);
        files = files.filter((f) => {
          const filePath = f.newPath !== '/dev/null' ? f.newPath : f.oldPath;
          // Match by exact path or by path suffix (handle different path formats)
          return (
            selectedPaths.has(filePath) ||
            [...selectedPaths].some((sp) => filePath.endsWith(sp) || sp.endsWith(filePath))
          );
        });
      }

      if (files.length === 0) {
        throw new Error('No changes to commit');
      }

      return { message: buildHeuristicCommitMessage(files) };
    }),
});
