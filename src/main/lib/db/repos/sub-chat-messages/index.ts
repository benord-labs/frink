import { and, asc, desc, eq, exists, gt, gte, inArray, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { getDatabase } from '../../index';
import { subChatMessages, subChats } from '../../schema';
import { reportCorruptTranscript } from '../../transcript-corruption';
import type { Message } from '../sub-chats';

type Db = ReturnType<typeof getDatabase>;

/** A transcript as stored: `rows[seq]` is message `seq`'s JSON, the baseline `writeTranscript` diffs. */
type StoredTranscript = { rows: string[]; messages: Message[] };

/** A row that fails to parse is skipped and reported, so one bad message never hides the rest. */
function parseRows(subChatId: string, rows: string[]): Message[] {
  const messages: Message[] = [];
  for (const row of rows) {
    try {
      messages.push(JSON.parse(row) as Message);
    } catch (err) {
      reportCorruptTranscript(subChatId, row, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return messages;
}

/** Equal JSON spelled differently (`1e21`) is unchanged, so untouched rows stay byte-identical. */
function sameMessage(json: string, stored: string | undefined): boolean {
  if (json === stored) return true;
  if (stored === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(stored)) === json;
  } catch {
    return false;
  }
}

export function readTranscript(db: Db, subChatId: string): StoredTranscript {
  const rows = db
    .select({ message: subChatMessages.message })
    .from(subChatMessages)
    .where(eq(subChatMessages.subChatId, subChatId))
    .orderBy(asc(subChatMessages.seq))
    .all()
    .map((row) => row.message);
  return { rows, messages: parseRows(subChatId, rows) };
}

/**
 * Writes `next` over the rows `prev` was read as, touching only messages whose JSON changed, and
 * bumps `sub_chats.updated_at` (the renderer's durability floor) only when something did.
 */
export function writeTranscript(
  db: Db,
  subChatId: string,
  prev: readonly string[],
  next: readonly Message[],
): boolean {
  let changed = false;
  next.forEach((message, seq) => {
    const json = JSON.stringify(message);
    if (sameMessage(json, prev[seq])) return;
    changed = true;
    db.insert(subChatMessages)
      .values({ subChatId, seq, message: json })
      .onConflictDoUpdate({
        target: [subChatMessages.subChatId, subChatMessages.seq],
        set: { message: json },
      })
      .run();
  });
  if (prev.length > next.length) {
    changed = true;
    db.delete(subChatMessages)
      .where(and(eq(subChatMessages.subChatId, subChatId), gte(subChatMessages.seq, next.length)))
      .run();
  }
  if (changed) touchSubChat(db, subChatId);
  return changed;
}

export function touchSubChat(db: Db, subChatId: string): void {
  db.update(subChats).set({ updatedAt: new Date() }).where(eq(subChats.id, subChatId)).run();
}

/** The one way outside the sub-chat repo to read transcripts, so their storage can change behind it. */
export function readTranscripts(db: Db, subChatIds: string[]): Map<string, Message[]> {
  if (subChatIds.length === 0) return new Map();
  // One query; the LEFT JOIN keeps an existing sub-chat with no messages (a null row).
  const rows = db
    .select({ id: subChats.id, message: subChatMessages.message })
    .from(subChats)
    .leftJoin(subChatMessages, eq(subChatMessages.subChatId, subChats.id))
    .where(inArray(subChats.id, subChatIds))
    .orderBy(asc(subChats.id), asc(subChatMessages.seq))
    .all();
  const rowsById = new Map<string, string[]>();
  for (const { id, message } of rows) {
    const stored = rowsById.get(id) ?? [];
    if (message !== null) stored.push(message);
    rowsById.set(id, stored);
  }
  return new Map([...rowsById].map(([id, stored]) => [id, parseRows(id, stored)]));
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

/** The task of the newest dispatch-stamped user row that an assistant reply follows: the prompt this
 * session last provably received. A stamped prompt nothing answered (preflight-rejected) is skipped. */
export function latestAnsweredDispatchTaskId(db: Db, subChatId: string): string | null {
  const reply = alias(subChatMessages, 'reply');
  const taskId = sql<
    string | null
  >`json_extract(${subChatMessages.message}, '$.metadata.dispatchTaskId')`;
  const row = db
    .select({ taskId })
    .from(subChatMessages)
    .where(
      and(
        eq(subChatMessages.subChatId, subChatId),
        // Cheap substring prefilter so json_extract only parses candidate rows.
        sql`instr(${subChatMessages.message}, '"dispatchTaskId"') > 0`,
        sql`${taskId} IS NOT NULL`,
        exists(
          db
            .select({ one: sql`1` })
            .from(reply)
            .where(
              and(
                eq(reply.subChatId, subChatId),
                gt(reply.seq, subChatMessages.seq),
                sql`json_extract(${reply.message}, '$.role') = 'assistant'`,
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(subChatMessages.seq))
    .limit(1)
    .get();
  return row?.taskId ?? null;
}

/** SQL that holds while the sub-chat exists and its transcript still equals `messages`. */
export function transcriptUnchanged(db: Db, subChatId: string, messages: unknown[]): SQL {
  const { message, seq } = subChatMessages;
  const stored = sql`(SELECT group_concat(${message}, ',' ORDER BY ${seq}) FROM ${subChatMessages} WHERE ${subChatMessages.subChatId} = ${subChatId})`;
  return sql`${exists(
    db
      .select({ one: sql`1` })
      .from(subChats)
      .where(eq(subChats.id, subChatId)),
  )} AND json('[' || coalesce(${stored}, '') || ']') IS json(${JSON.stringify(messages)})`;
}

/** Copies a transcript onto another existing sub-chat (fork). Must run in the caller's transaction. */
export function copyTranscript(db: Db, fromSubChatId: string, toSubChatId: string): void {
  db.insert(subChatMessages)
    .select(
      db
        .select({
          subChatId: sql<string>`${toSubChatId}`.as('sub_chat_id'),
          seq: subChatMessages.seq,
          message: subChatMessages.message,
        })
        .from(subChatMessages)
        .where(eq(subChatMessages.subChatId, fromSubChatId)),
    )
    .run();
}
