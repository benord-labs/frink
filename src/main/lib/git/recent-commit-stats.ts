import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import { createGit } from './git-factory';

export type RecentCommitStats = { commits: number; insertions: number; deletions: number };

/** Printed once per commit, so the count holds for any hash format (SHA-1 or SHA-256). */
const COMMIT_MARKER = 'frink-commit';
// Translations keep git's (+) and (-) markers, so these match in any locale.
const INSERTIONS = /(\d+) [^,]*\(\+\)/;
const DELETIONS = /(\d+) [^,]*\(-\)/;

/** Diffstat of the last `count` commits, or null when the path has no git history. */
export async function getRecentCommitStats(
  projectPath: string,
  count = 10,
): Promise<RecentCommitStats | null> {
  let log: string;
  try {
    // --shortstat prints one summary line per commit, so the output stays small.
    log = await createGit(projectPath).raw([
      'log',
      `-${count}`,
      '--shortstat',
      `--format=tformat:${COMMIT_MARKER}`,
    ]);
  } catch {
    return null;
  }
  const stats: RecentCommitStats = { commits: 0, insertions: 0, deletions: 0 };
  for (const line of log.split('\n')) {
    if (line === COMMIT_MARKER) stats.commits++;
    stats.insertions += Number(INSERTIONS.exec(line)?.[1] ?? 0);
    stats.deletions += Number(DELETIONS.exec(line)?.[1] ?? 0);
  }
  return stats.commits > 0 ? stats : null;
}

export const createRecentCommitStatsRouter = () =>
  router({
    getRecentCommitStats: publicProcedure
      .input(z.object({ projectPath: z.string() }))
      .query(({ input }) => getRecentCommitStats(input.projectPath)),
  });
