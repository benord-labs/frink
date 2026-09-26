import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { subChats } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

/**
 * Patch ONLY the last message's `parts` in SQLite, so the checkpoint that fires every 10th chunk
 * (on the loop that drains the agent SDK's stdout) no longer round-trips the whole transcript
 * through V8. Measured 2.5–5x per checkpoint; cost still grows with transcript length inside
 * SQLite's C JSON code — docs/decisions/live-run-observer-lane.md records the limit.
 *
 * Load-bearing, not stylistic: `json_set` not `json_replace` (replace is a silent no-op on a
 * missing path and STILL reports a changed row); `$[#-1].parts` not `$[#-1]` (replacing the element
 * would erase `metadata`, whose `sdkMessageUuid` the rollback control resolves its stash by);
 * `json_valid` in the WHERE (a corrupt row must fall through to the rewrite, whose
 * `safeParseMessages` heals it, instead of raising `malformed JSON` here).
 */
export function patchLastAssistantParts(
  db: Db,
  subChatId: string,
  assistantMessageId: string,
  parts: unknown[],
): boolean {
  const encoded = JSON.stringify(parts);
  const result = db
    .update(subChats)
    .set({
      messages: drizzleSql`json_set(${subChats.messages}, '$[#-1].parts', json(${encoded}), '$[#-1].role', 'assistant')`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(subChats.id, subChatId),
        drizzleSql`json_valid(${subChats.messages})`,
        drizzleSql`json_extract(${subChats.messages}, '$[#-1].id') = ${assistantMessageId}`,
        // A repeated identical checkpoint must not touch the row (its updatedAt is the renderer's
        // durability floor), so it falls through to the rewrite's byte-compare instead.
        drizzleSql`json_extract(${subChats.messages}, '$[#-1].parts') IS NOT json(${encoded})`,
      ),
    )
    .run();
  return result.changes > 0;
}
