import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import { fetchGitHubPRStatus } from './github';

export const createGitOperationsRouter = () => {
  return router({
    getGitHubStatus: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
        }),
      )
      .query(async ({ input }) => {
        return await fetchGitHubPRStatus(input.worktreePath);
      }),
  });
};
