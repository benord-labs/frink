/**
 * Worktree teardown + recovery — shared by chats.delete / chats.archive(Batch) / projects.delete.
 *
 * Lives here (not in git/worktree.ts) so the pure-git layer stays db-free: this orchestration is
 * db-aware (sibling check + project lookup + active-chat references). git ops are delegated to
 * git/worktree.ts (removeWorktree / pruneWorktrees / listWorktrees).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { eq, isNull } from 'drizzle-orm';
import log from 'electron-log';
import type { getDatabase } from '../../../db';
import { hasOtherActiveChatsSharingWorktree } from '../../../db/repos/chats';
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
 * result — if the query throws (DB busy), we treat it as indeterminate and SKIP (the boot sweep
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
    hasSiblings = await hasOtherActiveChatsSharingWorktree(db, chatId, worktreePath);
  } catch (error) {
    log.warn(
      '[tearDownChatWorktree] sibling check failed — skipping removal, boot sweep will reclaim',
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
    log.warn('[tearDownChatWorktree] removeWorktree failed — boot sweep will reclaim', {
      worktreePath,
      error: res.error,
    });
  }
  return res.success;
}

/**
 * Project-delete teardown: all the project's chats are going away, so the per-chat sibling check is
 * moot — kill each chat's terminals (release handles) and remove each distinct worktree directly
 * against the project repo. Background; the boot sweep backstops any failures.
 */
export async function removeProjectWorktrees(
  mainRepoPath: string,
  projectChats: Array<{ id: string; worktreePath: string | null; branch: string | null }>,
): Promise<void> {
  await Promise.all(
    projectChats.map((c) => terminalManager.killByWorkspaceId(c.id).catch(() => {})),
  );
  const byPath = new Map<string, string | null>();
  for (const c of projectChats) {
    if (c.worktreePath && c.branch) byPath.set(c.worktreePath, c.branch);
  }
  for (const [worktreePath, branch] of byPath) {
    await removeWorktree(mainRepoPath, worktreePath, { branch });
  }
}

/**
 * Does `dir` still have a working git-worktree linkage? A functional worktree always has a `.git`
 * file pointing at a live admin dir (`gitdir: …`); a nested repo has a `.git` directory. A broken
 * stub git has forgotten (e.g. `territorial-solstice` — only a leftover `.husky/`, no `.git`) has
 * neither, or a `.git` file whose gitdir target is gone. This is the load-bearing guard for the
 * filesystem sweep below: it spares anything git can still operate on (so we never destroy a real
 * worktree of an unrelated repo that happens to live under the base) and condemns only dead stubs.
 */
const WORKTREE_GITDIR_RE = /^gitdir:\s*(.+)$/m;

export function hasLiveGitLinkage(dir: string): boolean {
  const gitPath = join(dir, '.git');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(gitPath);
  } catch {
    return false; // no `.git` entry → dead stub
  }
  if (stat.isDirectory()) return true; // embedded/nested repo → keep
  const gitdir = readFileSync(gitPath, 'utf-8').match(WORKTREE_GITDIR_RE)?.[1]?.trim();
  if (!gitdir) return false;
  return existsSync(isAbsolute(gitdir) ? gitdir : join(dir, gitdir));
}

/**
 * Reclaim one candidate `<slug>/<folder>` dir iff it's a git-forgotten orphan. Removed only when no
 * active chat references it, git no longer lists it, and it has no live `.git` linkage. We skip the
 * uncommitted/unpushed checks the git loop runs — a stub with no live linkage cannot hold
 * recoverable git work, and `hasLiveGitLinkage` already spares anything that could. A locked/
 * unreadable orphan (EBUSY/EACCES — the class removeWorktree retries) is left for the next boot,
 * never aborting the sweep. Returns true only when the dir was removed.
 */
async function reclaimIfOrphan(
  worktreeDir: string,
  knownGitPaths: Set<string>,
  referenced: Set<string>,
): Promise<boolean> {
  if (referenced.has(worktreeDir)) return false; // a live chat owns it
  if (knownGitPaths.has(worktreeDir)) return false; // git still lists it
  if (hasLiveGitLinkage(worktreeDir)) return false; // functional worktree → never destroy
  try {
    await fs.rm(worktreeDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Reclaim orphans within one project slug dir, then rmdir it if it ends up empty (ENOTEMPTY → in use). */
async function sweepSlugDir(
  slugDir: string,
  knownGitPaths: Set<string>,
  referenced: Set<string>,
): Promise<number> {
  const folders = await fs.readdir(slugDir, { withFileTypes: true }).catch(() => []);
  let orphaned = 0;
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    if (await reclaimIfOrphan(join(slugDir, folder.name), knownGitPaths, referenced)) orphaned += 1;
  }
  await fs.rmdir(slugDir).catch(() => {});
  return orphaned;
}

/**
 * Reclaim leftover worktree directories under the managed base that git has forgotten entirely —
 * the failure class `git worktree remove` reports as `… is not a working tree` and `git worktree
 * prune` cannot delete (prune only clears admin entries, never the on-disk dir). Scans the canonical
 * `<base>/<slug>/<folder>` shape: `config.json` is a depth-1 file, so descending only into depth-2
 * dirs skips it inherently.
 */
export async function sweepOrphanWorktreeDirs(
  baseDir: string,
  knownGitPaths: Set<string>,
  referenced: Set<string>,
): Promise<number> {
  if (!baseDir) return 0; // never scan an unresolved root
  const slugs = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  let orphaned = 0;
  for (const slug of slugs) {
    if (slug.isDirectory()) {
      orphaned += await sweepSlugDir(join(baseDir, slug.name), knownGitPaths, referenced);
    }
  }
  return orphaned;
}

/**
 * Boot-time backstop: reconcile each project's git worktrees against active chats, then sweep the
 * managed worktree base for dirs git has forgotten entirely.
 *  - `git worktree prune` clears stale registrations (dirs already gone). Repo-wide, so this is the
 *    ONLY place we prune (never per-teardown — see pruneWorktrees doc).
 *  - Any Frink-MARKED worktree git still tracks that NO registered project or active
 *    (non-archived) chat references is removed — UNLESS it holds uncommitted/unpushed work (never
 *    destroy that: a paused start_task merge-conflict worktree has no chat row yet but holds the
 *    conflict the user must resolve). Positive worktree-scoped ownership is load-bearing: Git's
 *    registry is repository-global and also lists manual worktrees Frink must never delete. Legacy
 *    Frink worktrees without the marker may leak rather than risk a destructive false positive.
 *    Project roots are protected because Frink itself may be running from a linked worktree.
 *  - `sweepOrphanWorktreeDirs` then reclaims git-forgotten leftover dirs under `worktreeBaseDir`
 *    (the global base, injected by the boot caller so this can never scan an unexpected root under
 *    test). Scope: git-FORGOTTEN orphans under a per-project `worktree-base-path` override are NOT
 *    swept — git-tracked worktrees there are still covered by the git-loop above; reclaiming
 *    forgotten orphans there is a deliberate out-of-scope call (see docs/decisions).
 * Idempotent: a no-op when there's no drift. Run AFTER flow/task recovery so in-flight work settles.
 */
export async function recoverOrphanedWorktrees(
  db: Db,
  worktreeBaseDir: string,
): Promise<{ pruned: number; removed: number; skipped: number; orphaned: number }> {
  // QA launches Frink with an isolated userData/DB, but Git's worktree registry is shared by every
  // app instance that opens the same repository. A QA boot therefore cannot distinguish its own
  // unreferenced worktrees from a clean worktree that the owner's live app is still using (stashing
  // makes that exact state possible). Keep the opt-out at the destructive boundary, not only in the
  // startup caller, so a future recovery entry point cannot bypass it accidentally.
  if (process.env.FRINK_DISABLE_WORKTREE_RECOVERY === '1') {
    return { pruned: 0, removed: 0, skipped: 0, orphaned: 0 };
  }

  const activeRows = await db
    .select({ worktreePath: chats.worktreePath })
    .from(chats)
    .where(isNull(chats.archivedAt));
  const allProjects = await listProjects(db);
  const referenced = new Set([
    ...activeRows.map((r) => r.worktreePath).filter((p): p is string => Boolean(p)),
    ...allProjects.map((project) => project.path).filter((p): p is string => Boolean(p)),
  ]);

  let pruned = 0;
  let removed = 0;
  let skipped = 0;
  const knownGitPaths = new Set<string>();

  for (const project of allProjects) {
    if (!project.path) continue;

    const before = await listWorktrees(project.path).catch(() => []);
    if (before.length === 0) continue; // not a git repo / unreadable — skip

    for (const w of before) knownGitPaths.add(w.path); // keep-set for the fs sweep
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
      const res = await removeWorktree(project.path, wt.path, { branch: wt.branch });
      if (res.success) removed += 1;
    }
  }

  const orphaned = await sweepOrphanWorktreeDirs(worktreeBaseDir, knownGitPaths, referenced);

  return { pruned, removed, skipped, orphaned };
}
