import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import { getWorktreeDiff } from '../../../../git';
import { computeContentHash, gitCache } from '../../../../git/cache';
import { splitUnifiedDiffByFile } from '../../../../git/diff-parser';
import { publicProcedure, router } from '../../../index';

/**
 * Parsed diff operations
 * Purpose: Get the chat's uncommitted diff split per file (cached for performance)
 */
export const parsedDiffRouter = router({
  /**
   * Get the parsed diff. Parsing runs here so the renderer never blocks on it,
   * and GitCache answers instantly while the diff is unchanged.
   */
  getParsedDiff: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(async ({ input }) => {
      const chat = await getChatByIdLocal(getDatabase(), input.chatId);

      if (!chat?.worktreePath) {
        return {
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          error: 'No worktree path',
        };
      }

      // 1. Get raw diff (only uncommitted changes - don't show branch diff after commit)
      const result = await getWorktreeDiff(chat.worktreePath, chat.baseBranch ?? undefined, {
        onlyUncommitted: true,
      });

      if (!result.success) {
        return {
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          error: result.error,
        };
      }

      // 2. Check cache using diff hash
      const diffHash = computeContentHash(result.diff || '');
      type ParsedDiffResponse = {
        files: ReturnType<typeof splitUnifiedDiffByFile>;
        totalAdditions: number;
        totalDeletions: number;
      };
      const cached = gitCache.getParsedDiff<ParsedDiffResponse>(chat.worktreePath, diffHash);
      if (cached) {
        return cached;
      }

      // 3. Parse diff into files
      const files = splitUnifiedDiffByFile(result.diff || '');

      // 4. Calculate totals
      const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
      const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

      const response: ParsedDiffResponse = {
        files,
        totalAdditions,
        totalDeletions,
      };

      // 5. Store in cache
      gitCache.setParsedDiff(chat.worktreePath, diffHash, response);
      return response;
    }),
});
