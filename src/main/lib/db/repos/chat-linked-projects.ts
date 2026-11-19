import fs from 'node:fs';
import { and, eq, inArray, notLike, sql } from 'drizzle-orm';
import { isPathWithinProject } from '../../permissions/path-check';
import { guardedFolders, isRootFolder } from '../../permissions/v2/linked-read/root-folder';
import type { getDatabase } from '../index';
import { chatLinkedProjects, chats, type Project, projects } from '../schema';

type Db = ReturnType<typeof getDatabase>;

/** Why a project cannot be linked to a chat. */
export type LinkRefusal =
  | 'chat-not-found'
  | 'general-chat'
  | 'virtual-chat'
  | 'project-not-found'
  | 'main-project'
  | 'virtual-folder'
  | 'root-folder'
  | 'folder-missing'
  | 'overlaps-main';

export type LinkResult = { ok: true } | { ok: false; reason: LinkRefusal };

type MoveDestination = { projectId: string | null; worktreePath: string | null };

const isVirtual = (dir: string) => dir.startsWith('virtual://');
const linkOrder = sql`${chatLinkedProjects}.rowid`;
const ofChat = (chatId: string) => eq(chatLinkedProjects.chatId, chatId);

/** Either folder is, or holds, the other, by real path. */
function overlapsAny(dir: string, mainFolders: Array<string | null | undefined>): boolean {
  return mainFolders.some(
    (main) => !!main && (isPathWithinProject(dir, main) || isPathWithinProject(main, dir)),
  );
}

/** The links the agent may read now: each folder on disk and apart from the chat's own folders.
 * One rule for what the agent is told and what the permission gate lets it read. */
export function liveLinks<T extends { path: string }>(links: T[], ownFolders: string[]): T[] {
  return links.filter((link) => fs.existsSync(link.path) && !overlapsAny(link.path, ownFolders));
}

/** The chat's linked projects in the order they were linked. Virtual folders are never linked. */
export function listLinkedProjects(db: Db, chatId: string): Project[] {
  return db
    .select({ project: projects })
    .from(chatLinkedProjects)
    .innerJoin(projects, eq(projects.id, chatLinkedProjects.projectId))
    .where(and(ofChat(chatId), notLike(projects.path, 'virtual://%')))
    .orderBy(linkOrder)
    .all()
    .map((row) => row.project);
}

export function listLinkedProjectRoots(
  db: Db,
  chatId: string,
): Array<{ projectId: string; path: string }> {
  return listLinkedProjects(db, chatId).map((project) => ({
    projectId: project.id,
    path: project.path,
  }));
}

type LinkingChat = { projectId: string; path: string; worktreePath: string | null };

/** The chat with its own project's folder, or why it can link nothing. */
function linkingChat(db: Db, chatId: string): LinkingChat | LinkRefusal {
  const chat = db
    .select({ projectId: chats.projectId, worktreePath: chats.worktreePath, path: projects.path })
    .from(chats)
    .leftJoin(projects, eq(projects.id, chats.projectId))
    .where(eq(chats.id, chatId))
    .get();
  if (!chat) return 'chat-not-found';
  if (!chat.projectId || !chat.path) return 'general-chat';
  if (isVirtual(chat.path)) return 'virtual-chat';
  return { projectId: chat.projectId, path: chat.path, worktreePath: chat.worktreePath };
}

/** Why `target` can't be linked to `chat`. `guarded` is guardedFolders(), read once for a list. */
function targetRefusal(
  chat: LinkingChat,
  target: Project,
  guarded: readonly string[],
): LinkRefusal | null {
  if (target.id === chat.projectId) return 'main-project';
  if (isVirtual(target.path)) return 'virtual-folder';
  if (isRootFolder(target.path, guarded)) return 'root-folder';
  if (!fs.existsSync(target.path)) return 'folder-missing';
  if (overlapsAny(target.path, [chat.path, chat.worktreePath])) return 'overlaps-main';
  return null;
}

function linkRefusal(db: Db, chatId: string, projectId: string): LinkRefusal | null {
  const chat = linkingChat(db, chatId);
  if (typeof chat === 'string') return chat;
  const target = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!target) return 'project-not-found';
  return targetRefusal(chat, target, guardedFolders());
}

/** The projects linkProjectToChat would link to the chat now, leaving out those already linked:
 * what the Link picker offers. The chat and the guarded folders are read once for the list. */
export function listLinkableProjectIds(db: Db, chatId: string): string[] {
  const chat = linkingChat(db, chatId);
  if (typeof chat === 'string') return [];
  const linked = new Set(listLinkedProjects(db, chatId).map((project) => project.id));
  const guarded = guardedFolders();
  return db
    .select()
    .from(projects)
    .all()
    .filter((target) => !linked.has(target.id) && targetRefusal(chat, target, guarded) === null)
    .map(({ id }) => id);
}

/** The chats that link the project, which a delete or rename of it changes. */
export function listChatsLinkingProject(db: Db, projectId: string): string[] {
  return db
    .select({ chatId: chatLinkedProjects.chatId })
    .from(chatLinkedProjects)
    .where(eq(chatLinkedProjects.projectId, projectId))
    .all()
    .map((row) => row.chatId);
}

/** Links a project's registered folder to the chat. Linking it again is a no-op. */
export function linkProjectToChat(db: Db, chatId: string, projectId: string): LinkResult {
  return db.transaction(() => {
    const reason = linkRefusal(db, chatId, projectId);
    if (reason) return { ok: false, reason };
    db.insert(chatLinkedProjects).values({ chatId, projectId }).onConflictDoNothing().run();
    return { ok: true };
  });
}

/** Unlinking a project that is not linked is a no-op. True when a link was removed. */
export function unlinkProjectFromChat(db: Db, chatId: string, projectId: string): boolean {
  const result = db
    .delete(chatLinkedProjects)
    .where(and(ofChat(chatId), eq(chatLinkedProjects.projectId, projectId)))
    .run();
  return result.changes > 0;
}

/** A fork links the same projects as its source, in the same order. Runs inside the fork. */
export function copyChatLinks(db: Db, fromChatId: string, toChatId: string): void {
  const rows = db.select().from(chatLinkedProjects).where(ofChat(fromChatId)).orderBy(linkOrder);
  const copies = rows.all().map((row) => ({ ...row, chatId: toChatId }));
  if (copies.length > 0) db.insert(chatLinkedProjects).values(copies).run();
}

/** Drops each link to a folder that is, holds or sits inside one of `folders`, such as the
 * worktree a chat just switched to. True when a link was dropped. */
export function dropLinksOverlapping(
  db: Db,
  chatId: string,
  folders: Array<string | null>,
): boolean {
  const dropped = listLinkedProjectRoots(db, chatId)
    .filter((link) => overlapsAny(link.path, folders))
    .map((link) => link.projectId);
  if (dropped.length === 0) return false;
  db.delete(chatLinkedProjects)
    .where(and(ofChat(chatId), inArray(chatLinkedProjects.projectId, dropped)))
    .run();
  return true;
}

/** Runs inside a move: a general chat or virtual folder keeps no links, and a link to the new
 * project, or to a folder that is, holds or sits inside its folder or worktree, is dropped. True
 * when a link was dropped. */
export function settleLinksAfterMove(db: Db, chatId: string, to: MoveDestination): boolean {
  const main = to.projectId
    ? db.select().from(projects).where(eq(projects.id, to.projectId)).get()
    : undefined;
  if (!main || isVirtual(main.path)) {
    return db.delete(chatLinkedProjects).where(ofChat(chatId)).run().changes > 0;
  }
  const unlinked = unlinkProjectFromChat(db, chatId, main.id);
  return dropLinksOverlapping(db, chatId, [main.path, to.worktreePath]) || unlinked;
}
