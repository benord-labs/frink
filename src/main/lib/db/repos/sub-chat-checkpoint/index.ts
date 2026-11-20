import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { subChatMessages, subChats } from '../../schema';
import { touchSubChat } from '../sub-chat-messages';
import type { Message } from '../sub-chats';

type Db = ReturnType<typeof getDatabase>;

/** Patches ONLY the last message row's `parts`, so a streaming checkpoint rewrites one row, not
 * the transcript. `.run().changes`, never `.returning()`, which would read the row back. */
export function patchLastAssistantParts(
  db: Db,
  subChatId: string,
  assistantMessageId: string,
  parts: unknown[],
): 'patched' | 'unchanged' | null {
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
        // A repeated identical checkpoint must not touch the row: its updatedAt is the renderer's
        // durability floor.
        drizzleSql`json_extract(${message}, '$.parts') IS NOT json(${encoded})`,
      ),
    )
    .run();
  if (result.changes > 0) {
    touchSubChat(db, subChatId);
    return 'patched';
  }
  return lastRowAlreadyHolds(db, subChatId, assistantMessageId, encoded) ? 'unchanged' : null;
}

/** Selects the max(seq) row only when it is a readable assistant message with this id. */
function lastRowIsAssistant(subChatId: string, assistantMessageId: string) {
  const { message, seq } = subChatMessages;
  return and(
    eq(subChatMessages.subChatId, subChatId),
    drizzleSql`${seq} = (SELECT max(${seq}) FROM ${subChatMessages} WHERE ${subChatMessages.subChatId} = ${subChatId})`,
    drizzleSql`json_valid(${message})`,
    drizzleSql`json_extract(${message}, '$.id') = ${assistantMessageId}`,
    drizzleSql`json_extract(${message}, '$.role') = 'assistant'`,
  );
}

/** Whether the last row is already this assistant message with these parts, read in SQLite. */
function lastRowAlreadyHolds(
  db: Db,
  subChatId: string,
  assistantMessageId: string,
  encodedParts: string,
): boolean {
  const head = db
    .select({
      same: drizzleSql<number>`json_extract(${subChatMessages.message}, '$.parts') IS json(${encodedParts})`,
    })
    .from(subChatMessages)
    .where(lastRowIsAssistant(subChatId, assistantMessageId))
    .get();
  return head?.same === 1;
}

/** The last row, parsed, when it is this assistant message; null sends the caller to the full read. */
export function readLastAssistantIfId(
  db: Db,
  subChatId: string,
  assistantMessageId: string,
): { seq: number; message: Message } | null {
  const head = db
    .select({ seq: subChatMessages.seq, message: subChatMessages.message })
    .from(subChatMessages)
    .where(lastRowIsAssistant(subChatId, assistantMessageId))
    .get();
  if (!head) return null;
  // SAFETY: the WHERE guard admits only a json_valid row whose id and role make it a stored message.
  return { seq: head.seq, message: JSON.parse(head.message) as Message };
}

/** Overwrites one message row in place. The caller owns `sub_chats.updated_at`. */
export function writeMessageRow(db: Db, subChatId: string, seq: number, message: Message): void {
  db.update(subChatMessages)
    .set({ message: JSON.stringify(message) })
    .where(and(eq(subChatMessages.subChatId, subChatId), eq(subChatMessages.seq, seq)))
    .run();
}

/**
 * Appends `next` as the row after the last one when no readable row already has its id, without
 * reading the transcript into V8. A corrupt last row refuses, so the rewrite can drop it instead.
 */
export function appendNewMessage(db: Db, subChatId: string, next: Message): boolean {
  const { message, seq } = subChatMessages;
  const ofSubChat = drizzleSql`${subChatMessages.subChatId} = ${subChatId}`;
  const lastSeq = drizzleSql`(SELECT max(${seq}) FROM ${subChatMessages} WHERE ${ofSubChat})`;
  const result = db
    .insert(subChatMessages)
    .select(
      db
        .select({
          subChatId: drizzleSql<string>`${subChatId}`.as('sub_chat_id'),
          // max+1, never count: writeTranscript diffs rows by index, so seq must stay contiguous.
          seq: drizzleSql<number>`coalesce(${lastSeq}, -1) + 1`.as('seq'),
          message: drizzleSql<string>`${JSON.stringify(next)}`.as('message'),
        })
        .from(subChats)
        .where(
          and(
            eq(subChats.id, subChatId),
            drizzleSql`NOT EXISTS (SELECT 1 FROM ${subChatMessages} WHERE ${ofSubChat}
              AND json_valid(${message}) AND json_extract(${message}, '$.id') = ${next.id})`,
            drizzleSql`coalesce((SELECT json_valid(${message}) FROM ${subChatMessages}
              WHERE ${ofSubChat} AND ${seq} = ${lastSeq}), 1)`,
          ),
        ),
    )
    .run();
  if (result.changes === 0) return false;
  touchSubChat(db, subChatId);
  return true;
}
