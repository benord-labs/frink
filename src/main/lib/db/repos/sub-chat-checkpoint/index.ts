import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { subChatMessages } from '../../schema';
import { touchSubChat } from '../sub-chat-messages';

type Db = ReturnType<typeof getDatabase>;

/** Patches ONLY the last message row's `parts`, so a streaming checkpoint rewrites one row, not
 * the transcript. `.run().changes`, never `.returning()`, which would read the row back. */
export function patchLastAssistantParts(
  db: Db,
  subChatId: string,
  assistantMessageId: string,
  parts: unknown[],
): boolean {
  const encoded = JSON.stringify(parts);
  const { message, seq } = subChatMessages;
  const result = db
    .update(subChatMessages)
    .set({
      // json_set, not json_replace: replace no-ops on a missing path yet still reports a change.
      // `$.parts`, never the whole message: that erases metadata.sdkMessageUuid, used by rollback.
      message: drizzleSql`json_set(${message}, '$.parts', json(${encoded}), '$.role', 'assistant')`,
    })
    .where(
      and(
        eq(subChatMessages.subChatId, subChatId),
        drizzleSql`${seq} = (SELECT max(${seq}) FROM ${subChatMessages} WHERE ${subChatMessages.subChatId} = ${subChatId})`,
        // A corrupt row falls through to the rewrite, which skips it, instead of raising here.
        drizzleSql`json_valid(${message})`,
        drizzleSql`json_extract(${message}, '$.id') = ${assistantMessageId}`,
        // A repeated identical checkpoint must not touch the row (its updatedAt is the renderer's
        // durability floor), so it falls through to the rewrite's byte-compare instead.
        drizzleSql`json_extract(${message}, '$.parts') IS NOT json(${encoded})`,
      ),
    )
    .run();
  if (result.changes === 0) return false;
  touchSubChat(db, subChatId);
  return true;
}
