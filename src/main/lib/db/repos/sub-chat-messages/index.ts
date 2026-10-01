import { and, eq, exists, inArray, type SQL, sql } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { subChats } from '../../schema';
import { type Message, safeParseMessages } from '../sub-chats';

type Db = ReturnType<typeof getDatabase>;

/** The one way outside the sub-chat repo to read transcripts, so their storage can change behind it. */
export function readTranscripts(db: Db, subChatIds: string[]): Map<string, Message[]> {
  const transcripts = new Map<string, Message[]>();
  if (subChatIds.length === 0) return transcripts;
  const rows = db
    .select({ id: subChats.id, messages: subChats.messages })
    .from(subChats)
    .where(inArray(subChats.id, subChatIds))
    .all();
  for (const row of rows) transcripts.set(row.id, safeParseMessages(row.id, row.messages));
  return transcripts;
}

/** Null when the sub-chat does not exist; true when it exists and no `messageId` is asked for. */
export function transcriptHasMessage(
  db: Db,
  subChatId: string,
  messageId: string | undefined,
): boolean | null {
  if (!messageId) {
    const row = db
      .select({ id: subChats.id })
      .from(subChats)
      .where(eq(subChats.id, subChatId))
      .get();
    return row ? true : null;
  }
  const transcript = readTranscripts(db, [subChatId]).get(subChatId);
  return transcript ? transcript.some((message) => message.id === messageId) : null;
}

/** SQL that holds while the sub-chat's transcript still equals `messages`. */
export function transcriptUnchanged(db: Db, subChatId: string, messages: unknown[]): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(subChats)
      .where(
        and(
          eq(subChats.id, subChatId),
          sql`json(${subChats.messages}) IS json(${JSON.stringify(messages)})`,
        ),
      ),
  );
}

/** Copies a transcript onto another existing sub-chat (fork). Must run in the caller's transaction. */
export function copyTranscript(db: Db, fromSubChatId: string, toSubChatId: string): void {
  db.update(subChats)
    .set({
      messages: sql`(SELECT ${subChats.messages} FROM ${subChats} WHERE ${subChats.id} = ${fromSubChatId})`,
    })
    .where(eq(subChats.id, toSubChatId))
    .run();
}
