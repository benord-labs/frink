import { z } from 'zod';

/** A finished agent turn's context occupancy and compaction count, as a Flow node outputs them;
 * null = the provider cannot report it, never "none happened". */
export type TurnUsage = { contextTokens: number | null; compactions: number | null };

/** What stamps merge into a task's result: occupancy is a level (newest wins); compactions are
 * kept per assistant message, so a re-stamped message replaces its count and a new one adds. */
export const storedTurnUsageSchema = z.object({
  contextTokens: z.number().optional(),
  compactionsByMessage: z.record(z.string(), z.number()).optional(),
});
export type StoredTurnUsage = z.infer<typeof storedTurnUsageSchema>;

export function nodeTurnUsage(stored: StoredTurnUsage): TurnUsage {
  const counts = Object.values(stored.compactionsByMessage ?? {});
  return {
    contextTokens: stored.contextTokens ?? null,
    compactions: counts.length > 0 ? counts.reduce((sum, n) => sum + n, 0) : null,
  };
}
