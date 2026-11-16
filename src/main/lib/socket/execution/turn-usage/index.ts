// A turn's context usage, stamped on its linked task before the terminal flip so its Flow node
// can output it; the transcript finalize lands too late to be the source.

import log from 'electron-log';
import { z } from 'zod';
import type { AssistantMessageMetadata } from '../../../../../shared/types/assistant-message';
import type { StoredTurnUsage } from '../../../../../shared/types/turn-usage';
import type { UIMessageChunk } from '../../../claude/types';
import { getDatabase } from '../../../db';
import { patchTaskTurnUsage } from '../../../db/repos/task-turn-usage';

/** A compaction card that settled; a failed or still-streaming card carries another state. */
const settledCompactionSchema = z.object({
  type: z.literal('data-compact'),
  id: z.string(),
  data: z.object({ state: z.literal('output-available') }),
});

const contextTokensSchema = z.number();

/** The usage-bearing trailer: the LAST finish chunk, as a failed resume can leave an earlier one. */
export function lastFinishMetadata(chunks: readonly UIMessageChunk[]) {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk.type === 'finish')
      return 'messageMetadata' in chunk ? chunk.messageMetadata : undefined;
  }
  return undefined;
}

function settledCompactionCount(parts: readonly { type: string }[]): number {
  const ids = new Set<string>();
  for (const part of parts) {
    const settled = settledCompactionSchema.safeParse(part);
    if (settled.success) ids.add(settled.data.id);
  }
  return ids.size;
}

/**
 * Patches only `result.turnUsage`, never the status; a lost measurement never fails the turn.
 * `reportsCompactions` false = the provider cannot report them, so the count is null, not 0.
 */
export async function stampTurnUsage(
  taskId: string | null | undefined,
  messageId: string,
  metadata: Pick<AssistantMessageMetadata, 'contextTokens' | 'promptCacheExpiresAt'> | undefined,
  finalParts: readonly { type: string }[],
  reportsCompactions: boolean,
): Promise<void> {
  if (!taskId) return;
  const patch: StoredTurnUsage = {};
  // No value means "keep the last known occupancy", so an unreported turn adds nothing.
  const tokens = contextTokensSchema.safeParse(metadata?.contextTokens);
  if (tokens.success) patch.contextTokens = tokens.data;
  // Unlike occupancy, an unreported expiry is unknown, never the last turn's.
  patch.promptCacheExpiresAt = metadata?.promptCacheExpiresAt ?? null;
  if (reportsCompactions) {
    patch.compactionsByMessage = { [messageId]: settledCompactionCount(finalParts) };
  }
  try {
    // needs_attention: a burst can end before its un-park of a quiet-idle park lands.
    await patchTaskTurnUsage(getDatabase(), taskId, patch, [
      'running',
      'failed',
      'needs_attention',
    ]);
  } catch (error) {
    log.warn('[Socket Executor] Failed to record turn usage', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
