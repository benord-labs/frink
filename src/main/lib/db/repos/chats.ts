import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { getDatabase } from '../index';
import { type Chat, chats, type NewChat, type SubChat, subChats } from '../schema';
import { createId } from '../utils';
import { getProjectAiAccount } from './project-ai-accounts';
import { createSubChat, listSubChatsByChat } from './sub-chats';

type Db = ReturnType<typeof getDatabase>;

/**
 * Local SQLite chat repository (Phase 1 local-first migration).
 *
 * Mirrors the read/write surface that `src/main/lib/cloud/chats.ts` provides over HTTP, but
 * against the local SQLite chats table. Returns Drizzle row shapes verbatim — callers map to
 * renderer-facing types via `src/main/lib/trpc/routers/chats/map-chat-response.ts` (Task 20).
 *
 * Single-user DB, so there's no `userId` filter — every row belongs to the current desktop user.
 */

export async function createChat(db: Db, input: NewChat): Promise<Chat> {
  const [row] = await db.insert(chats).values(input).returning();
  return row;
}

export async function getChatById(db: Db, id: string): Promise<Chat | null> {
  const [row] = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
  return row ?? null;
}

/** Non-archived chats for a project (or null = "general / no project"), newest first. */
export async function listChatsForProject(db: Db, projectId: string | null): Promise<Chat[]> {
  return db
    .select()
    .from(chats)
    .where(
      and(
        projectId === null ? isNull(chats.projectId) : eq(chats.projectId, projectId),
        isNull(chats.archivedAt),
      ),
    )
    .orderBy(desc(chats.updatedAt), desc(chats.id));
}

/** Non-archived chats across all projects (and null/general), newest first. */
export async function listAllChats(db: Db): Promise<Chat[]> {
  return db
    .select()
    .from(chats)
    .where(isNull(chats.archivedAt))
    .orderBy(desc(chats.updatedAt), desc(chats.id));
}

/** Archived chats across all projects (and null/general), most recently archived first. */
export async function listAllArchivedChats(db: Db): Promise<Chat[]> {
  // id desc as the tie-break: same-millisecond archives (batch ops) would otherwise return in an
  // unstable order and shuffle the list between refetches. Mirrors listAllChats.
  return db
    .select()
    .from(chats)
    .where(isNotNull(chats.archivedAt))
    .orderBy(desc(chats.archivedAt), desc(chats.id));
}

/**
 * Count of non-archived chats grouped by project_id (NULL projectId = general bucket).
 * Filter-parity invariant: this MUST share the same `isNull(archivedAt)` + projectId filter as
 * `pageChatsForProjects`. The sidebar derives its folder header count from here and its rows from
 * there; the count-drift self-heal assumes they can only diverge transiently, so a permanent
 * filter mismatch would leave the header count and the rows silently out of sync.
 */
export async function countChatsByProject(
  db: Db,
): Promise<Array<{ projectId: string | null; count: number }>> {
  const rows = await db
    .select({ projectId: chats.projectId, count: sql<number>`count(*)` })
    .from(chats)
    .where(isNull(chats.archivedAt))
    .groupBy(chats.projectId);
  return rows.map((r) => ({ projectId: r.projectId, count: Number(r.count) }));
}

/**
 * True when at least one OTHER non-archived chat (id != excludeChatId) shares the given
 * worktree path. Used by archive flows to decide whether removing the worktree on disk is
 * safe — fork chats share a worktree and the last reference must keep it alive.
 */
export async function hasOtherActiveChatsSharingWorktree(
  db: Db,
  excludeChatId: string,
  worktreePath: string,
): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(chats)
    .where(
      and(
        eq(chats.worktreePath, worktreePath),
        isNull(chats.archivedAt),
        sql`${chats.id} != ${excludeChatId}`,
      ),
    );
  return Number(row?.count ?? 0) > 0;
}

export async function findChatByWorktree(db: Db, worktreePath: string): Promise<Chat | null> {
  const [row] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.worktreePath, worktreePath), isNull(chats.archivedAt)))
    .orderBy(desc(chats.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Idempotent chat + sub-chat provisioning for a flow `start_task`. Keyed on the
 * deterministic worktree path so a flow-run retry (resume → re-dispatch) reuses
 * the same chat instead of leaking orphans — chats/sub_chats have no unique
 * index (unlike tasks). A NEW chat + its sub-chat go in ONE transaction so a
 * mid-failure can't leave a chat with zero sub-chats. Returns the ids the
 * downstream agent runs in.
 */
export async function getOrCreateFlowChat(
  db: Db,
  input: { projectId: string; name: string; worktreePath: string | null },
): Promise<{ chatId: string; subChatId: string }> {
  const existing = input.worktreePath ? await findChatByWorktree(db, input.worktreePath) : null;
  if (existing) {
    const subs = await listSubChatsByChat(db, existing.id);
    const subChatId =
      subs[0]?.id ??
      (
        await createSubChat(db, {
          chatId: existing.id,
          name: input.name,
          mode: 'agent',
          messages: '[]',
        })
      ).id;
    return { chatId: existing.id, subChatId };
  }
  return db.transaction(() => {
    const chat = db
      .insert(chats)
      .values({
        projectId: input.projectId,
        name: input.name,
        mode: 'agent',
        worktreePath: input.worktreePath,
      })
      .returning()
      .get() as Chat;
    const subChat = db
      .insert(subChats)
      .values({ chatId: chat.id, name: input.name, mode: 'agent', messages: '[]' })
      .returning()
      .get() as SubChat;
    return { chatId: chat.id, subChatId: subChat.id };
  });
}

/**
 * Link a chat to its driving task. The sidebar marks a chat as a task off `chats.taskId` (icon +
 * the `linkedChatId` join that powers the status badge). Guarded `task_id IS NULL` so the FIRST
 * agent in a multi-agent flow chain wins and later agents are no-ops — mirrors cloud node-dispatch.
 * Does NOT bump `updatedAt` (avoids reordering the sidebar row). Returns true when this call set
 * the link.
 */
export async function linkChatToTask(db: Db, chatId: string, taskId: string): Promise<boolean> {
  const rows = await db
    .update(chats)
    .set({ taskId })
    .where(and(eq(chats.id, chatId), isNull(chats.taskId)))
    .returning({ id: chats.id });
  return rows.length > 0;
}

export async function updateChat(
  db: Db,
  id: string,
  patch: Partial<Omit<Chat, 'id' | 'createdAt'>>,
): Promise<Chat | null> {
  const [row] = await db
    .update(chats)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(chats.id, id))
    .returning();
  return row ?? null;
}

/**
 * Per-chat worktree history: JSON-as-text on `chats.worktree_history`. Shape is
 * `Record<projectId, worktreePath>` — when a chat is moved out of a project we record where
 * it was so a future move BACK to that project can auto-restore the original worktree.
 * Defensive: tolerates null/undefined/malformed JSON and drops non-string entries.
 */
export function parseWorktreeHistory(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Pure: add/overwrite the entry for `projectId`. No-op when either arg is null. */
export function appendWorktreeHistory(
  h: Record<string, string>,
  projectId: string | null,
  worktreePath: string | null,
): Record<string, string> {
  if (!projectId || !worktreePath) return h;
  return { ...h, [projectId]: worktreePath };
}

/** Pure: read the entry for `projectId`, or null. */
export function lookupWorktreeHistoryEntry(
  h: Record<string, string>,
  projectId: string | null,
): string | null {
  if (!projectId) return null;
  return h[projectId] ?? null;
}

/** Pure: drop the entry for `projectId` (used after a stale fs.existsSync miss). */
export function pruneWorktreeHistoryEntry(
  h: Record<string, string>,
  projectId: string,
): Record<string, string> {
  if (!(projectId in h)) return h;
  const next = { ...h };
  delete next[projectId];
  return next;
}

/**
 * Move a chat to a project. Caller resolves the target workspace (project root, restored
 * worktree from history, or explicit MCP override) and passes the chat's new
 * worktree-history JSON. This helper writes both atomically in a single transaction so a
 * concurrent move can't corrupt the row.
 *
 * Returns `previousWorktreePath` so callers can invalidate the stale gitCache for the old
 * path (gitCache lives in the git layer, not here — mirrors switchWorktree).
 */
export async function moveChatToProjectLocal(
  db: Db,
  id: string,
  opts: {
    projectId: string | null;
    worktreePath: string | null;
    branch: string | null;
    baseBranch: string | null;
    /**
     * Optional projectId the resolver flagged for pruning (its history entry's worktree dir
     * was missing on disk). Applied inside the transaction so a concurrent move can't have
     * its writes lost to a stale pre-pruning history snapshot.
     */
    stalePrunedProjectId: string | null;
  },
): Promise<{ updated: Chat | null; previousWorktreePath: string | null }> {
  return db.transaction(() => {
    const current = db.select().from(chats).where(eq(chats.id, id)).get() as Chat | undefined;
    if (!current) return { updated: null, previousWorktreePath: null };

    // Read history fresh inside the transaction (defends against TOCTOU where two moves
    // interleave with a stale parsed-history snapshot). Then drop the stale entry the
    // resolver flagged (if any) and append the chat's current departure state.
    let nextHistory = parseWorktreeHistory(current.worktreeHistory);
    if (opts.stalePrunedProjectId) {
      nextHistory = pruneWorktreeHistoryEntry(nextHistory, opts.stalePrunedProjectId);
    }
    nextHistory = appendWorktreeHistory(nextHistory, current.projectId, current.worktreePath);

    const updated = db
      .update(chats)
      .set({
        projectId: opts.projectId,
        worktreePath: opts.worktreePath,
        branch: opts.branch,
        baseBranch: opts.baseBranch,
        worktreeHistory: JSON.stringify(nextHistory),
        updatedAt: new Date(),
      })
      .where(eq(chats.id, id))
      .returning()
      .get() as Chat | undefined;

    return { updated: updated ?? null, previousWorktreePath: current.worktreePath ?? null };
  });
}

export async function archiveChat(db: Db, id: string): Promise<Chat | null> {
  return updateChat(db, id, { archivedAt: new Date() });
}

export async function unarchiveChat(db: Db, id: string): Promise<Chat | null> {
  return updateChat(db, id, { archivedAt: null });
}

/**
 * Paginated chats across one or more projects, keyset cursor on (updated_at, id) descending.
 * Filter-parity invariant: keep the same `isNull(archivedAt)` + projectId filter as
 * `countChatsByProject` — the sidebar's folder rows come from here, its header count from there,
 * and any divergence drifts them apart permanently.
 */
export type PageCursor = { updatedAt: Date; id: string };

export async function pageChatsForProjects(
  db: Db,
  args: {
    projectIds: readonly (string | null)[];
    limit: number;
    cursor?: PageCursor;
  },
): Promise<Chat[]> {
  const { projectIds, limit, cursor } = args;
  if (projectIds.length === 0) return [];

  const idList = projectIds.filter((p): p is string => p !== null);
  const includeNull = projectIds.some((p) => p === null);

  const projectClause = (() => {
    if (idList.length > 0 && includeNull)
      return or(inArray(chats.projectId, idList), isNull(chats.projectId));
    if (idList.length > 0) return inArray(chats.projectId, idList);
    return isNull(chats.projectId);
  })();

  const cursorClause = cursor
    ? or(
        lt(chats.updatedAt, cursor.updatedAt),
        and(eq(chats.updatedAt, cursor.updatedAt), lt(chats.id, cursor.id)),
      )
    : undefined;

  return db
    .select()
    .from(chats)
    .where(and(projectClause, isNull(chats.archivedAt), cursorClause))
    .orderBy(desc(chats.updatedAt), desc(chats.id))
    .limit(limit);
}

/** All pinned chats across the given projects (max 100 rows, no pagination — mirrors cloud route). */
export async function listPinnedChatsForProjects(
  db: Db,
  projectIds: readonly (string | null)[],
): Promise<Chat[]> {
  if (projectIds.length === 0) return [];

  const idList = projectIds.filter((p): p is string => p !== null);
  const includeNull = projectIds.some((p) => p === null);

  const projectClause = (() => {
    if (idList.length > 0 && includeNull)
      return or(inArray(chats.projectId, idList), isNull(chats.projectId));
    if (idList.length > 0) return inArray(chats.projectId, idList);
    return isNull(chats.projectId);
  })();

  return db
    .select()
    .from(chats)
    .where(and(projectClause, isNotNull(chats.pinnedAt), isNull(chats.archivedAt)))
    .orderBy(desc(chats.pinnedAt))
    .limit(100);
}

export async function togglePin(db: Db, id: string): Promise<Chat | null> {
  const current = await getChatById(db, id);
  if (!current) return null;
  return updateChat(db, id, { pinnedAt: current.pinnedAt ? null : new Date() });
}

/**
 * Resolves a chat + its project's AI account override (`project_ai_accounts`), `null` when
 * there's no project or no override. `id` resolves the credential, `label` is for messages.
 * The account read is fenced in its own try, separate from the chat read: the caller wraps
 * this in `.catch(() => null)`, so propagating an override failure would also discard the
 * chat's worktree/task context and silently run the agent against the main checkout.
 */
export async function getChatWithProjectAccount(
  db: Db,
  chatId: string,
): Promise<{ chat: Chat; account: { id: string; label: string | null } | null } | null> {
  const chat = await getChatById(db, chatId);
  if (!chat) return null;
  let account: { id: string; label: string | null } | null = null;
  if (chat.projectId) {
    try {
      account = await getProjectAiAccount(db, chat.projectId);
    } catch {
      account = null;
    }
  }
  return { chat, account };
}

/**
 * Local replacement for cloud `updateChatBranchByWorktreePath`.
 * Returns `true` if a matching active chat was updated, `false` if none matched.
 */
export async function updateChatBranchByWorktreePath(
  db: Db,
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  const chat = await findChatByWorktree(db, worktreePath);
  if (!chat) return false;
  await updateChat(db, chat.id, { branch });
  return true;
}

/**
 * Deep-copy a chat and its sub-chats with fresh IDs in a single sync transaction.
 * Mirrors the cloud `forkChatWithSubChats` semantics — the new chat inherits the source
 * worktree/branch (callers may override afterward) and every sub-chat gets a new id while
 * preserving its messages JSON, mode, sessionId, etc.
 *
 * Returns the new chat + new sub-chats. Throws if the source chat doesn't exist.
 */
export async function forkChatWithSubChats(
  db: Db,
  sourceChatId: string,
): Promise<{ chat: Chat; subChats: SubChat[] }> {
  const newChatId = createId();
  return db.transaction(() => {
    const source = db.select().from(chats).where(eq(chats.id, sourceChatId)).get() as
      | Chat
      | undefined;
    if (!source) throw new Error(`Source chat not found: ${sourceChatId}`);

    const sourceSubs = db
      .select()
      .from(subChats)
      .where(eq(subChats.chatId, sourceChatId))
      .all() as SubChat[];

    const now = new Date();
    db.insert(chats)
      .values({
        id: newChatId,
        name: source.name,
        projectId: source.projectId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        worktreePath: source.worktreePath,
        branch: source.branch,
        baseBranch: source.baseBranch,
        prUrl: null,
        prNumber: null,
        taskId: null,
        mode: source.mode,
        pinnedAt: null,
        // Forks share the source chat's project visit history so a fork moved A→B→A still
        // auto-restores the original worktree (forks intentionally share worktrees too).
        worktreeHistory: source.worktreeHistory,
      })
      .run();

    const newSubs: SubChat[] = [];
    for (const sub of sourceSubs) {
      const newSubId = createId();
      const inserted = db
        .insert(subChats)
        .values({
          id: newSubId,
          chatId: newChatId,
          name: sub.name,
          sessionId: null,
          streamId: null,
          mode: sub.mode,
          messages: sub.messages,
          additions: sub.additions ?? 0,
          deletions: sub.deletions ?? 0,
          fileCount: sub.fileCount ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get() as SubChat;
      newSubs.push(inserted);
    }

    const newChat = db.select().from(chats).where(eq(chats.id, newChatId)).get() as Chat;
    return { chat: newChat, subChats: newSubs };
  });
}
