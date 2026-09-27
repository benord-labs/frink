import { and, eq, ne } from 'drizzle-orm';
import log from 'electron-log';
import { isHtmlArtifactPart } from '../../../../shared/lib/artifacts/html-artifact';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { isFrinkPlanReadyPart, type MessagePartLike } from '../../../../shared/types/plan';
import { recordCheckpointPersist } from '../../diagnostics/stream-cadence';
import type { getDatabase } from '../index';
import { type NewSubChat, type SubChat, subChats } from '../schema';
import { reportCorruptTranscript } from '../transcript-corruption';
import { patchLastAssistantParts } from './sub-chat-checkpoint';
import { logSessionHandleChange, writeSubChatSession } from './sub-chat-session';
import { bumpWriteGeneration, isStaleWrite, withSubChatLock } from './sub-chat-mutex';

type Db = ReturnType<typeof getDatabase>;

/**
 * Local SQLite sub-chats repository. Every read-modify-write of the `messages` JSON column runs
 * inside BOTH `withSubChatLock` (async serialization across streams targeting one sub-chat) and
 * `db.transaction` (sync atomicity for SELECT-then-UPDATE). The transaction callback must stay
 * SYNCHRONOUS — async work inside it silently breaks atomicity — and reuses the outer `db`, which
 * the single connection routes into the open txn (codebase pattern, see claude-code.ts:1392).
 */

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: unknown[];
  metadata?: unknown;
};

export type SubChatHydrated = Omit<SubChat, 'messages'> & { messages: Message[] };

/**
 * One corrupt `messages` row used to throw an unguarded `JSON.parse` and crash export, list, stats
 * and chats.get for the WHOLE chat (commits 7e06b0 … f655a8); it now degrades to `[]` so the rest
 * of the chat stays usable, and reports (see `reportCorruptTranscript`).
 */
function hydrate(row: SubChat): SubChatHydrated {
  return { ...row, messages: safeParseMessages(row.id, row.messages) };
}

export async function createSubChat(db: Db, input: NewSubChat): Promise<SubChatHydrated> {
  const [row] = await db.insert(subChats).values(input).returning();
  return hydrate(row);
}

export async function getSubChatById(db: Db, id: string): Promise<SubChatHydrated | null> {
  const [row] = await db.select().from(subChats).where(eq(subChats.id, id)).limit(1);
  return row ? hydrate(row) : null;
}

export async function listSubChatsByChat(db: Db, chatId: string): Promise<SubChatHydrated[]> {
  const rows = await db.select().from(subChats).where(eq(subChats.chatId, chatId));
  return rows.map(hydrate);
}

/**
 * The oldest sub-chat (by createdAt, lexical `id` tie-break for determinism) — its
 * title is the parent chat's title, so renaming either side keeps them in sync.
 * Rows have no inherent order, so never rely on array position. Null when empty.
 */
export function pickOldestSubChat(subs: SubChatHydrated[]): SubChatHydrated | null {
  if (subs.length === 0) return null;
  return subs.reduce((a, b) => {
    const at = +new Date(a.createdAt ?? 0);
    const bt = +new Date(b.createdAt ?? 0);
    if (at !== bt) return at < bt ? a : b;
    return a.id < b.id ? a : b;
  });
}

/**
 * A chat's conversation row: every chat has exactly one sub-chat. Null before it exists (the
 * caller creates it). The single definition of which sub-chat a `continue_chat` task drives —
 * `createChatForTask` and the flow session-resume gate must agree.
 */
export async function getSubChatForChat(db: Db, chatId: string): Promise<SubChatHydrated | null> {
  return pickOldestSubChat(await listSubChatsByChat(db, chatId));
}

/**
 * Defensive parse: a corrupt row degrades to `[]` so writes can still proceed.
 * Exported so satellite stats / aggregation routers (`stats/*`) can apply the same
 * hardening when they read `sub_chats.messages` directly via Drizzle (i.e. without
 * going through the repo's hydrate path).
 */
export function safeParseMessages(rowId: string, raw: string): Message[] {
  try {
    const parsed = JSON.parse(raw) as Message[];
    if (Array.isArray(parsed)) return parsed;
    reportCorruptTranscript(rowId, raw, new Error('messages JSON is not an array'));
  } catch (err) {
    reportCorruptTranscript(rowId, raw, err instanceof Error ? err : new Error(String(err)));
  }
  return [];
}

/** Read-modify-write over the messages column. `mutate` runs sync in the txn; never await in it.
 * `onWrite` fires only when the row was really rewritten (an identical result short-circuits). */
function withMessagesSync(
  db: Db,
  subChatId: string,
  mutate: (messages: Message[]) => Message[],
  onWrite?: () => void,
): SubChatHydrated | null {
  return db.transaction(() => {
    const row = db.select().from(subChats).where(eq(subChats.id, subChatId)).get() as
      | SubChat
      | undefined;
    if (!row) return null;

    const messages = safeParseMessages(row.id, row.messages);
    const next = mutate(messages);
    const nextJson = JSON.stringify(next);

    if (nextJson === row.messages) return { ...row, messages };

    db.update(subChats)
      .set({
        messages: nextJson,
        updatedAt: new Date(),
      })
      .where(eq(subChats.id, subChatId))
      .run();
    onWrite?.();

    return { ...row, messages: next };
  });
}

export async function appendUserMessage(
  db: Db,
  subChatId: string,
  message: Message,
): Promise<SubChatHydrated | null> {
  return withSubChatLock(subChatId, async () =>
    withMessagesSync(db, subChatId, (msgs) => [...msgs, message]),
  );
}

export type AppendHtmlArtifactResult = 'inserted' | 'duplicate' | 'missing';

/** Atomically deduplicate and append an artifact message. */
export async function appendHtmlArtifactMessage(
  db: Db,
  subChatId: string,
  message: Message,
  artifactId: string,
): Promise<AppendHtmlArtifactResult> {
  return withSubChatLock(subChatId, async () => {
    let result: AppendHtmlArtifactResult = 'missing';
    const subChat = withMessagesSync(db, subChatId, (messages) => {
      const duplicate = messages.some(
        (existing) =>
          Array.isArray(existing.parts) &&
          existing.parts.some(
            (part) => isHtmlArtifactPart(part) && part.data.artifactId === artifactId,
          ),
      );
      if (duplicate) {
        result = 'duplicate';
        return messages;
      }
      result = 'inserted';
      return [...messages, message];
    });
    return subChat ? result : 'missing';
  });
}

export type SeedUserMessageResult = {
  seeded: boolean;
  subChat: SubChatHydrated | null;
};

function parseMessagesForSeed(row: SubChat): Message[] | null {
  try {
    const parsed = JSON.parse(row.messages) as unknown;
    if (Array.isArray(parsed)) return parsed as Message[];
  } catch (err) {
    log.warn(`[sub-chats] refusing to seed unparseable messages for sub-chat ${row.id}`, err);
    return null;
  }
  log.warn(`[sub-chats] refusing to seed non-array messages for sub-chat ${row.id}`);
  return null;
}

/** Seed an empty sub-chat once without replacing history written by a concurrent actor. */
export async function seedUserMessageIfEmpty(
  db: Db,
  subChatId: string,
  message: Message,
): Promise<SeedUserMessageResult> {
  return withSubChatLock(subChatId, async () =>
    db.transaction(() => {
      const row = db.select().from(subChats).where(eq(subChats.id, subChatId)).get() as
        | SubChat
        | undefined;
      if (!row) return { seeded: false, subChat: null };
      const messages = parseMessagesForSeed(row);
      if (!messages) return { seeded: false, subChat: { ...row, messages: [] } };
      if (messages.length > 0) {
        return { seeded: false, subChat: { ...row, messages } };
      }
      const next = [message];
      db.update(subChats)
        .set({
          messages: JSON.stringify(next),
          updatedAt: new Date(),
        })
        .where(eq(subChats.id, subChatId))
        .run();
      return {
        seeded: true,
        subChat: { ...row, messages: next },
      };
    }),
  );
}

/**
 * Place an assistant message into a message list by id — appending when absent, replacing when
 * present — and report which it was so callers can apply their own rules to an insert.
 *
 * Metadata survives a caller that has none to offer. Both writers REPLACE rather than patch, so
 * omitting it would erase what is already there, and no caller ever means to: an error-path finalize
 * and every checkpoint write simply don't carry it, and a later write to the same id (a wake burst
 * appending to the turn that armed it) would otherwise drop the arming turn's usage — and its
 * `sdkMessageUuid`, which is what the rollback control resolves its stash by.
 */
export function placeAssistantMessage(
  messages: Message[],
  assistantMessageId: string,
  parts: unknown[],
  metadata: unknown,
): { idx: number; messages: Message[] } {
  const idx = messages.findIndex((m) => m.id === assistantMessageId);
  // Presence, not truthiness — `metadata` is `unknown`, so a falsy-but-real value must survive.
  const kept = metadata ?? messages[idx]?.metadata ?? undefined;
  const next: Message = {
    id: assistantMessageId,
    role: 'assistant',
    parts,
    ...(kept !== undefined ? { metadata: kept } : {}),
  };
  return {
    idx,
    messages: idx === -1 ? [...messages, next] : messages.map((m, i) => (i === idx ? next : m)),
  };
}

/** True when parts carry nothing a reader could see — empty, or step-start markers only. */
function isContentlessParts(parts: unknown[]): boolean {
  // SAFETY: parts are persisted UI message parts; each is an object whose `type` discriminates.
  return parts.every((p) => (p as { type?: string } | undefined)?.type === 'step-start');
}

/** Which branch ran — tests assert it; the streaming caller ignores it. */
export type UpsertOutcome =
  | 'patched'
  | 'rewritten'
  | 'appended'
  | 'unchanged'
  | 'dropped'
  | 'missing';

export async function upsertAssistantMessage(
  db: Db,
  subChatId: string,
  assistantMessageId: string,
  parts: unknown[],
  generation: number, // the generation this stream started against (assistant-chunk-checkpoint.ts)
): Promise<UpsertOutcome> {
  return withSubChatLock(subChatId, async () => {
    // Timed inside the lock: checkpoints for one sub-chat queue here, and billing that queue wait
    // as loop-blocking would over-report a Frink-side stall.
    const startedAt = performance.now();
    const outcome = db.transaction(() => {
      if (isStaleWrite(subChatId, generation)) return 'dropped';
      if (patchLastAssistantParts(db, subChatId, assistantMessageId, parts)) return 'patched';

      const row = db.select().from(subChats).where(eq(subChats.id, subChatId)).get() as
        | SubChat
        | undefined;
      if (!row) return 'missing';

      const { idx, messages: nextMessages } = placeAssistantMessage(
        safeParseMessages(row.id, row.messages),
        assistantMessageId,
        // checkpoints never carry metadata, and the fast path above cannot express one either
        parts,
        undefined,
      );

      const nextJson = JSON.stringify(nextMessages);
      if (nextJson === row.messages) return 'unchanged';

      db.update(subChats)
        .set({
          messages: nextJson,
          updatedAt: new Date(),
        })
        .where(eq(subChats.id, subChatId))
        .run();

      return idx === -1 ? 'appended' : 'rewritten';
    });
    recordCheckpointPersist(performance.now() - startedAt, parts.length);
    return outcome;
  });
}

export async function finalizeAssistantMessage(
  db: Db,
  subChatId: string,
  assistantMessageId: string,
  parts: unknown[],
  sessionId: string | null,
  metadata?: unknown,
  generation?: number, // finalize APPENDS, so a rolled-away turn must not put its message back
): Promise<SubChatHydrated | null> {
  return withSubChatLock(subChatId, async () => {
    return db.transaction(() => {
      if (isStaleWrite(subChatId, generation)) return null;
      const row = db.select().from(subChats).where(eq(subChats.id, subChatId)).get() as
        | SubChat
        | undefined;
      if (!row) return null;

      const existing = safeParseMessages(row.id, row.messages);
      // A contentless finalize (aborted or silently-superseded turn) must not wipe parts that
      // mid-stream checkpoints already persisted — finalize REPLACES, so pass the checkpoint back.
      let finalParts = parts;
      if (isContentlessParts(parts)) {
        const checkpointed = existing.find((m) => m.id === assistantMessageId)?.parts;
        if (Array.isArray(checkpointed) && !isContentlessParts(checkpointed)) {
          finalParts = checkpointed;
        }
      }

      const { messages: next } = placeAssistantMessage(
        existing,
        assistantMessageId,
        finalParts,
        metadata,
      );
      const nextJson = JSON.stringify(next);
      const nextSessionId = sessionId ?? row.sessionId;
      logSessionHandleChange(subChatId, row.sessionId, nextSessionId, 'finalize');

      db.update(subChats)
        .set({
          messages: nextJson,
          sessionId: nextSessionId,
          streamId: null,
          updatedAt: new Date(),
        })
        .where(eq(subChats.id, subChatId))
        .run();

      return {
        ...row,
        messages: next,
        sessionId: nextSessionId,
        streamId: null,
      };
    });
  });
}

export async function setStreamId(
  db: Db,
  subChatId: string,
  streamId: string | null,
): Promise<void> {
  await db
    .update(subChats)
    .set({ streamId, updatedAt: new Date() })
    .where(eq(subChats.id, subChatId));
}

export async function clearStreamId(db: Db, subChatId: string): Promise<void> {
  await setStreamId(db, subChatId, null);
}

/** Delegates to sub-chat-session/, which logs a dropped or swapped handle (sc-2462). */
export async function updateSubChatSession(
  db: Db,
  subChatId: string,
  sessionId: string,
  reason = 'persist',
): Promise<void> {
  await writeSubChatSession(db, subChatId, sessionId, reason);
}

/**
 * The mode column alone. Deliberately NOT `getSubChatById`, which selects the whole row and parses
 * the `messages` blob: this feeds the flow bottom surface's poll, which re-reads every few seconds
 * for the life of a run. `null` for a missing row, so callers can fall back rather than guess.
 */
export async function getSubChatMode(db: Db, subChatId: string): Promise<ChatMode | null> {
  const [row] = await db
    .select({ mode: subChats.mode })
    .from(subChats)
    .where(eq(subChats.id, subChatId))
    .limit(1);
  return (row?.mode as ChatMode | undefined) ?? null;
}

export async function updateSubChatMode(
  db: Db,
  subChatId: string,
  // Phase 1.5 fix D: include 'debug' so the type matches the create + update routers
  // (both already accept it via Zod). Previously the router cast to 'plan' | 'agent'
  // erasing the value; the column itself is unconstrained text so 'debug' lands fine.
  mode: 'plan' | 'agent' | 'debug',
): Promise<void> {
  await db.update(subChats).set({ mode, updatedAt: new Date() }).where(eq(subChats.id, subChatId));
}

/**
 * Resolve the mode a message send runs in: an explicit transition intent wins and is persisted;
 * absent intent falls back to the row — the mode's single owner (decision
 * `sub-chat-mode-ownership`). No row AND no intent throws rather than guessing: defaulting to
 * 'agent' would open the turn on the permissive Auto path on a chat that may be mid-plan (see
 * `auto-mode-tool-approval`). The intent persist is ONE conditional UPDATE — no read-then-act
 * window for a concurrent mid-turn flip to be lost in — and an equal-mode row stays untouched
 * (updatedAt keys sync ordering; a missing row matches nothing, the temp- first-send case).
 */
export async function resolveSendMode(
  db: Db,
  subChatId: string,
  intent: ChatMode | undefined,
): Promise<ChatMode> {
  if (intent) {
    await db
      .update(subChats)
      .set({ mode: intent, updatedAt: new Date() })
      .where(and(eq(subChats.id, subChatId), ne(subChats.mode, intent)));
    return intent;
  }
  const rowMode = await getSubChatMode(db, subChatId);
  if (!rowMode) {
    throw new Error(
      `Cannot resolve chat mode for sub-chat ${subChatId}: no mode intent on the message and no persisted sub-chat row`,
    );
  }
  return rowMode;
}

export async function renameSubChat(db: Db, subChatId: string, name: string): Promise<void> {
  await db.update(subChats).set({ name, updatedAt: new Date() }).where(eq(subChats.id, subChatId));
}

export async function markPlanApproved(
  db: Db,
  subChatId: string,
  planId: string,
): Promise<SubChatHydrated | null> {
  return withSubChatLock(subChatId, async () =>
    withMessagesSync(db, subChatId, (msgs) =>
      msgs.map((m) => {
        const parts = (m.parts as MessagePartLike[]) ?? [];
        const updated = parts.map((p) =>
          isFrinkPlanReadyPart(p) && p.input?.planId === planId
            ? { ...p, input: { ...p.input, status: 'approved' } }
            : p,
        );
        return { ...m, parts: updated };
      }),
    ),
  );
}

/**
 * Wholesale transcript replacement from the row as it reads NOW (inside the lock + txn) — a
 * caller's earlier read would overwrite whatever landed since. `null`/`fresh` writes nothing.
 */
export async function updateSubChatMessages(
  db: Db,
  subChatId: string,
  transform: (fresh: Message[]) => Message[] | null,
): Promise<SubChatHydrated | null> {
  return withSubChatLock(subChatId, async () => {
    let wrote = false;
    const updated = withMessagesSync(
      db,
      subChatId,
      (fresh) => transform(fresh) ?? fresh,
      () => {
        wrote = true;
      },
    );
    // After the txn (a failed commit throws). Only a real rewrite fences live streams — bumping on
    // a no-op would drop every later chunk of an active turn.
    if (wrote) bumpWriteGeneration(subChatId);
    return updated;
  });
}
