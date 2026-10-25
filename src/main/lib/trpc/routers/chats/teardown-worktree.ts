/**
 * Worktree teardown + recovery — shared by chats.delete / chats.archive(Batch) / projects.delete.
 *
 * Lives here (not in git/worktree.ts) so the pure-git layer stays db-free: this orchestration is
 * db-aware (sibling check + project lookup + active-chat references). git ops are delegated to
 * git/worktree.ts (removeWorktree / pruneWorktrees / listWorktrees).
 */

import { eq, isNotNull } from 'drizzle-orm';
import log from 'electron-log';
import type { getDatabase } from '../../../db';
import { hasOtherChatsSharingWorktree } from '../../../db/repos/chats';
import { listProjects } from '../../../db/repos/projects';
import { chats, projects as projectsTable } from '../../../db/schema';
import { findUnmanagedWorktrees } from './git';
import {
  configureWorktreeHooks,
  hasUncommittedChanges,
  hasUnpushedCommits,
  isFrinkManagedWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from '../../../git/worktree';
import { captureContained } from '../../../sentry';
import { terminalManager } from '../../../terminal/manager';

type Db = ReturnType<typeof getDatabase>;

export type ChatWorktreeRef = {
  id: string;
  worktreePath: string | null;
  branch: string | null;
  projectId: string | null;
};

/**
 * Remove the worktree a chat owns, unless a forked sibling still shares it. Safe to call from any
 * chat-removal path. The sibling check is tri-state: we remove ONLY on a confirmed zero-siblings
 * result — if the query throws (DB busy), we treat it as indeterminate and SKIP (boot recovery
 * reclaims later), rather than assuming "no siblings" and force-deleting a live fork's worktree.
 *
 * Returns true only when the worktree was actually removed (callers that keep the chat row — e.g.
 * archive — use this to null worktreePath so a later restore doesn't point at a gone worktree).
 */
export async function tearDownChatWorktree(db: Db, chat: ChatWorktreeRef): Promise<boolean> {
  const { id: chatId, worktreePath, branch, projectId } = chat;
  if (!worktreePath || !branch || !projectId) return false;

  let hasSiblings: boolean;
  try {
    hasSiblings = await hasOtherChatsSharingWorktree(db, chatId, worktreePath);
  } catch (error) {
    log.warn(
      '[tearDownChatWorktree] sibling check failed — skipping removal, boot recovery will reclaim',
      {
        chatId,
        worktreePath,
        error,
      },
    );
    return false;
  }
  if (hasSiblings) return false;

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  if (!project) return false;

  const res = await removeWorktree(project.path, worktreePath, { branch });
  if (!res.success) {
    log.warn(
      '[tearDownChatWorktree] removeWorktree failed — left on disk; boot recovery reclaims it only while git lists it',
      {
        worktreePath,
        error: res.error,
      },
    );
  }
  return res.success;
}

/** After a project's cascade: kill its chats' terminals and remove each distinct worktree no
 *  surviving chat still holds. Background; boot recovery backstops failures git still lists. */
export async function removeProjectWorktrees(
  db: Db,
  mainRepoPath: string,
  projectChats: Array<{ id: string; worktreePath: string | null; branch: string | null }>,
): Promise<void> {
  await Promise.all(
    projectChats.map((c) => terminalManager.killByWorkspaceId(c.id).catch(() => {})),
  );
  const byPath = new Map<string, { chatId: string; branch: string }>();
  for (const c of projectChats) {
    if (c.worktreePath && c.branch) byPath.set(c.worktreePath, { chatId: c.id, branch: c.branch });
  }
  for (const [worktreePath, { chatId, branch }] of byPath) {
    if (await isWorktreeStillHeld(db, chatId, worktreePath)) continue;
    await removeWorktree(mainRepoPath, worktreePath, { branch });
  }
}

/** Same tri-state as tearDownChatWorktree: an indeterminate sibling check keeps the worktree. */
async function isWorktreeStillHeld(db: Db, chatId: string, worktreePath: string) {
  try {
    return await hasOtherChatsSharingWorktree(db, chatId, worktreePath);
  } catch (error) {
    log.warn('[worktree teardown] sibling check failed — skipping removal', {
      worktreePath,
      error,
    });
    return true;
  }
}

/** Boot backstop: prune, then remove unreferenced Frink-marked clean worktrees git still lists.
 * Keep-set, dirty/ownership guards and scope: docs/decisions/worktree-orphan-reclamation.md. */
export async function recoverOrphanedWorktrees(
  db: Db,
): Promise<{ pruned: number; removed: number; skipped: number }> {
  // QA launches Frink with an isolated userData/DB, but Git's worktree registry is shared by every
  // app instance that opens the same repository. A QA boot therefore cannot distinguish its own
  // unreferenced worktrees from a clean worktree that the owner's live app is still using (stashing
  // makes that exact state possible). Keep the opt-out at the destructive boundary, not only in the
  // startup caller, so a future recovery entry point cannot bypass it accidentally.
  if (process.env.FRINK_DISABLE_WORKTREE_RECOVERY === '1') {
    return { pruned: 0, removed: 0, skipped: 0 };
  }

  // Archived rows count too: archive is undoable and teardown defers to archived holders (sc-3292).
  const chatRows = await db
    .select({ worktreePath: chats.worktreePath })
    .from(chats)
    .where(isNotNull(chats.worktreePath));
  const allProjects = await listProjects(db);
  const referenced = new Set([
    ...chatRows.map((r) => r.worktreePath).filter((p): p is string => Boolean(p)),
    ...allProjects.map((project) => project.path).filter((p): p is string => Boolean(p)),
  ]);

  let pruned = 0;
  let removed = 0;
  let skipped = 0;

  for (const project of allProjects) {
    if (!project.path) continue;

    const before = await listWorktrees(project.path).catch(() => []);
    if (before.length === 0) continue; // not a git repo / unreadable — skip

    pruned += before.filter((w) => w.prunable).length;
    await pruneWorktrees(project.path);

    const unmanaged = await findUnmanagedWorktrees(
      before
        .filter((wt) => !wt.isMain && !wt.prunable && !referenced.has(wt.path))
        .map((wt) => wt.path),
      isFrinkManagedWorktree,
    );

    for (const wt of before) {
      if (wt.isMain || wt.prunable) continue; // main repo / already-pruned stale entry
      if (referenced.has(wt.path)) {
        // Existing chat worktrees can predate checkout-local Husky runners and retain Frink's
        // legacy absolute override. Repair only positively referenced worktrees at startup;
        // manual/unreferenced worktrees remain outside Frink's mutation boundary.
        await configureWorktreeHooks(project.path, wt.path).catch((error) => {
          log.warn('[recoverOrphanedWorktrees] failed to repair worktree hooks', {
            worktreePath: wt.path,
            error,
          });
          captureContained(error, { surface: 'worktree-hooks', stage: 'startup-repair' });
        });
        continue;
      }
      const isFrinkManaged =
        !unmanaged.has(wt.path) && (await isFrinkManagedWorktree(wt.path).catch(() => false));
      if (!isFrinkManaged) {
        skipped += 1;
        continue;
      }
      // Never force-delete unpushed/uncommitted work (errs toward "dirty" on check failure).
      const dirty =
        (await hasUncommittedChanges(wt.path).catch(() => true)) ||
        (await hasUnpushedCommits(wt.path).catch(() => true));
      if (dirty) {
        skipped += 1;
        continue;
      }
      // The referenced set is a snapshot: a chat may have taken this worktree since it was read.
      if (await isWorktreeStillHeld(db, '', wt.path)) {
        skipped += 1;
        continue;
      }
      const res = await removeWorktree(project.path, wt.path, { branch: wt.branch });
      if (res.success) removed += 1;
    }
  }

  return { pruned, removed, skipped };
}
