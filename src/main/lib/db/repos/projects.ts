import { and, desc, eq, inArray, isNull, notLike, or, sql } from 'drizzle-orm';
import type { getDatabase } from '../index';
import { chats, type NewProject, type Project, projects, subChats } from '../schema';
import {
  type DeleteChatsResult,
  deleteFlowQueueTasksForChats,
  listUnsettledFlowRunIdsForChats,
} from './task-queries/chat-flow-cleanup';

type Db = ReturnType<typeof getDatabase>;

/**
 * Local SQLite projects repository (project localization milestone, 0.0.5 priority #1).
 *
 * Mirrors the read/write surface that `src/main/lib/cloud/projects.ts` provided over HTTP,
 * but against the local SQLite projects table. Returns Drizzle row shapes verbatim — no
 * snake_case mapping. Single-user DB so no userId / machineId filters.
 *
 * IDs are cuid2 (from `createId()` in `db/utils.ts`), not Neon UUIDs.
 */

export async function createProject(db: Db, input: NewProject): Promise<Project> {
  const [row] = await db.insert(projects).values(input).returning();
  return row;
}

/** Insert-or-adopt by UNIQUE path, in one sync transaction so a concurrent delete can't land
 * between the conflict and the lookup. `createProject` stays strict — scaffoldBuild needs its throw. */
export async function createOrGetProjectByPath(
  db: Db,
  input: NewProject,
): Promise<{ project: Project; created: boolean }> {
  return db.transaction(() => {
    const row = db
      .insert(projects)
      .values(input)
      .onConflictDoNothing({ target: projects.path })
      .returning()
      .get();
    if (row) return { project: row, created: true };
    const existing = db.select().from(projects).where(eq(projects.path, input.path)).get();
    if (!existing) throw new Error(`Project for path ${input.path} vanished after conflict`);
    return { project: existing, created: false };
  });
}

export async function getProjectById(db: Db, id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectByPath(db: Db, path: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.path, path)).limit(1);
  return row ?? null;
}

/**
 * Candidate rows for a flow dispatch project key, matched by id OR exact name.
 *
 * Filtered in SQL and projected to three columns because a flow resolves this on every node
 * dispatch. Deliberately NOT limited: duplicate names are possible (only `path` is unique), and
 * the caller must see every name match to report the ambiguity instead of picking one.
 */
export async function findProjectsByIdOrName(
  db: Db,
  key: string,
): Promise<Array<{ id: string; name: string; path: string }>> {
  return db
    .select({ id: projects.id, name: projects.name, path: projects.path })
    .from(projects)
    .where(or(eq(projects.id, key), eq(projects.name, key)));
}

/** All projects, newest-updated first. Single-user — every row belongs to the current user. */
export async function listProjects(db: Db): Promise<Project[]> {
  return db.select().from(projects).orderBy(desc(projects.updatedAt));
}

/** `listProjects` minus virtual folders (`virtual://` paths): those group chats and have no
 * on-disk path, so they are never a codebase an agent can be pointed at. */
export async function listRealProjects(db: Db): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(notLike(projects.path, 'virtual://%'))
    .orderBy(desc(projects.updatedAt));
}

/** Projects by last chat activity (any `sub_chats` write: messages, streams, renames, mode). Not
 * `chats.updated_at`, which archiving moves. No sub-chats: sorted by creation, null `lastActiveAt`. */
export async function listProjectsByRecentActivity(
  db: Db,
): Promise<Array<Project & { lastActiveAt: Date | null }>> {
  const lastActiveAt = sql<Date | null>`max(${subChats.updatedAt})`.mapWith(subChats.updatedAt);
  const rows = await db
    .select({ project: projects, lastActiveAt })
    .from(projects)
    .leftJoin(chats, eq(chats.projectId, projects.id))
    .leftJoin(subChats, eq(subChats.chatId, chats.id))
    .groupBy(projects.id)
    .orderBy(desc(sql`coalesce(max(${subChats.updatedAt}), ${projects.createdAt})`));
  return rows.map((row) => ({ ...row.project, lastActiveAt: row.lastActiveAt }));
}

/** Which of `paths` an unarchived chat works in or a project is registered at. */
export function listClaimedPaths(db: Db, paths: string[]): Set<string> {
  const byChat = db
    .select({ path: chats.worktreePath })
    .from(chats)
    .where(and(inArray(chats.worktreePath, paths), isNull(chats.archivedAt)))
    .all();
  const byProject = db
    .select({ path: projects.path })
    .from(projects)
    .where(inArray(projects.path, paths))
    .all();
  return new Set([...byChat, ...byProject].flatMap((row) => (row.path ? [row.path] : [])));
}

export async function updateProject(
  db: Db,
  id: string,
  patch: Partial<Omit<Project, 'id' | 'createdAt'>>,
): Promise<Project | null> {
  const [row] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  return row ?? null;
}

type DeletedProjectChat = { id: string; worktreePath: string | null; branch: string | null };

/** `deletedChats` is what the cascade really dropped (read in the same transaction); `removed` is
 *  false when a concurrent delete already took the row, so the caller skips its cleanup. */
export type DeleteProjectResult =
  | Exclude<DeleteChatsResult, { deleted: true }>
  | { deleted: true; removed: boolean; deletedChats: DeletedProjectChat[] };

export async function deleteProject(db: Db, id: string): Promise<DeleteProjectResult> {
  return db.transaction(
    () => {
      const deletedChats = db
        .select({ id: chats.id, worktreePath: chats.worktreePath, branch: chats.branch })
        .from(chats)
        .where(eq(chats.projectId, id))
        .all();
      const chatIds = deletedChats.map((chat) => chat.id);
      const unsettledRunIds = listUnsettledFlowRunIdsForChats(db, chatIds);
      if (unsettledRunIds.length > 0) return { deleted: false, unsettledRunIds, chatIds };
      deleteFlowQueueTasksForChats(db, chatIds);
      const gone = db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
      return { deleted: true, removed: gone.all().length > 0, deletedChats };
    },
    { behavior: 'immediate' },
  );
}

/**
 * Rename a project ONLY if its current name still equals `expectedCurrentName` (the unnamed
 * placeholder). Returns the updated row, or null when no row matched (already named / a concurrent
 * caller won). The conditional `WHERE name = expected` makes a double-fire idempotent.
 */
export async function renameProjectIfPlaceholder(
  db: Db,
  id: string,
  name: string,
  expectedCurrentName: string,
): Promise<Project | null> {
  const [row] = await db
    .update(projects)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(projects.id, id), eq(projects.name, expectedCurrentName)))
    .returning();
  return row ?? null;
}

/**
 * Projects whose delete is in flight. projects.delete stops its chats' executors and Flow runs
 * before the cascade, so a chat must not leave (or join) the project in between.
 */
const deletingProjectIds = new Map<string, number>(); // count: concurrent deletes of one project

export class ProjectDeletionInProgressError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} is being deleted; its chats can't be moved right now.`);
    this.name = 'ProjectDeletionInProgressError';
  }
}

/** Marks `projectId` as being deleted; call the returned release once the delete settles. */
export function beginProjectDeletion(projectId: string): () => void {
  deletingProjectIds.set(projectId, (deletingProjectIds.get(projectId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (deletingProjectIds.get(projectId) ?? 1) - 1;
    if (left > 0) deletingProjectIds.set(projectId, left);
    else deletingProjectIds.delete(projectId);
  };
}

export function assertProjectNotBeingDeleted(projectId: string | null): void {
  if (projectId && deletingProjectIds.has(projectId)) {
    throw new ProjectDeletionInProgressError(projectId);
  }
}
