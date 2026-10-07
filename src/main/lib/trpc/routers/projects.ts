import { TRPCError } from '@trpc/server';
import { eq, inArray } from 'drizzle-orm';
import { app, BrowserWindow, dialog } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { trackProjectOpened } from '../../analytics';
import { getLaunchDirectory } from '../../cli';
import { getDatabase } from '../../db';
import {
  createProject as createProjectLocal,
  deleteProject as deleteProjectLocal,
  getProjectById as getProjectByIdLocal,
  listProjects as listProjectsLocal,
  listProjectsByRecentActivity,
  updateProject as updateProjectLocal,
} from '../../db/repos/projects';
import { chats, subChats } from '../../db/schema';
import { settleChatOwnedFlowDeletion } from '../../flows/deletion';
import { cancelFlowRunsForChatOrThrow } from '../../flows/engine';
import { getGitRemoteInfo } from '../../git';
import {
  createGitHubCloner,
  createProjectAtPath,
  openProjectAtPath,
  spawnGit,
} from '../../projects';
import { removeManagedBuildFolder, scaffoldBuild } from '../../project-scaffold';
import { abortActiveExecutionsForSubChats } from '../../socket/executor';
import { publicProcedure, router } from '../index';
import { removeProjectWorktrees } from './chats/teardown-worktree';
import { frinkUserHome } from '../../platform/frink-home';

/** Local-first projects router: every read/write goes through `db/repos/projects.ts`. */

const liveProjectDeps = {
  getDb: getDatabase,
  getGitRemoteInfo,
  trackProjectOpened,
  homeDir: frinkUserHome,
  spawnGit,
};
const cloneGitHubRepo = createGitHubCloner(liveProjectDeps);

function resolvePickerWindow(ctxWindow: BrowserWindow | null): BrowserWindow {
  const window = ctxWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window) return window;
  log.error('[projects.openFolder] No window available for folder picker', {
    isPackaged: app.isPackaged,
    windowCount: BrowserWindow.getAllWindows().length,
  });
  throw new Error('No app window available to open folder picker');
}

async function focusForPicker(window: BrowserWindow): Promise<void> {
  if (window.isFocused()) return;
  window.focus();
  // Small delay to ensure focus is applied by the OS (fixes first-launch on macOS)
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function showFolderPicker(window: BrowserWindow): Promise<Electron.OpenDialogReturnValue> {
  try {
    return await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Project Folder',
      buttonLabel: 'Open Project',
    });
  } catch (error) {
    log.error('[projects.openFolder] Failed to show folder picker dialog', {
      isPackaged: app.isPackaged,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Failed to open folder picker dialog');
  }
}

/** The folder the user picked, or null when they cancelled. */
async function pickProjectFolder(window: BrowserWindow): Promise<string | null> {
  await focusForPicker(window);
  const result = await showFolderPicker(window);
  const folderPath = result.canceled ? undefined : result.filePaths[0];
  if (!folderPath) log.info('[projects.openFolder] Folder picker canceled');
  return folderPath ?? null;
}

export const projectsRouter = router({
  /**
   * Get launch directory from CLI args (consumed once)
   * Based on PR #16 by @caffeinum
   */
  getLaunchDirectory: publicProcedure.query(() => {
    return getLaunchDirectory();
  }),

  /**
   * List all local projects, most recently active first.
   */
  list: publicProcedure.query(async () => listProjectsByRecentActivity(getDatabase())),

  /**
   * Get a single project by ID.
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const db = getDatabase();
    const project = await getProjectByIdLocal(db, input.id);
    return project;
  }),

  /**
   * Permissions overhaul ticket 01 — pure plumbing.
   * Toggles `projects.is_cross_machine`. No promotion side effects (ticket 07 owns that).
   */
  setCrossMachine: publicProcedure
    .input(z.object({ projectId: z.string().min(1), isCrossMachine: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const updated = await updateProjectLocal(db, input.projectId, {
        isCrossMachine: input.isCrossMachine,
      });
      if (!updated) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Project ${input.projectId} not found`,
        });
      }
      return updated;
    }),

  /**
   * Permissions overhaul ticket 01 — read the cross-machine flag.
   * Callers can also use `projects.get` (returns the full row including the flag).
   *
   * Returns `false` (not NOT_FOUND) for missing projects: this is a display-path
   * query, and treating "project gone" as "local-only" matches the safe-default
   * the storage layer falls back to anyway (ticket 06). Setter is asymmetric and
   * throws NOT_FOUND because mutating a missing row is a programmer bug.
   */
  getCrossMachine: publicProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = getDatabase();
      const project = await getProjectByIdLocal(db, input.projectId);
      return project?.isCrossMachine ?? false;
    }),

  /**
   * Open folder picker and create (or refresh) a local project.
   */
  openFolder: publicProcedure.mutation(async ({ ctx }) => {
    const folderPath = await pickProjectFolder(resolvePickerWindow(ctx.getWindow?.() ?? null));
    return folderPath ? openProjectAtPath(liveProjectDeps, folderPath) : null;
  }),

  /**
   * Goal-first scaffold (epic sc-788): turn a free-form goal into a gitless plain-folder
   * project under `~/.frink/builds/<slug>`. The renderer then opens a chat with
   * `useWorktree:false`. Non-technical users never see git/repo concepts.
   */
  scaffold: publicProcedure
    .input(z.object({ goal: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await scaffoldBuild(input.goal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('[projects.scaffold] Failed:', message, err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /**
   * Create a project from a known path.
   */
  create: publicProcedure
    .input(z.object({ path: z.string(), name: z.string().optional() }))
    .mutation(({ input }) => createProjectAtPath(liveProjectDeps, input.path, input.name)),

  /**
   * Rename a project.
   */
  rename: publicProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      return updateProjectLocal(db, input.id, { name: input.name });
    }),

  /**
   * Create a virtual folder for organizing chats (not tied to filesystem).
   */
  createFolder: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const virtualPath = `virtual://folders/${Date.now()}-${input.name.toLowerCase().replace(/\s+/g, '-')}`;
      const newProject = await createProjectLocal(db, {
        name: input.name,
        path: virtualPath,
      });
      return newProject;
    }),

  /**
   * Delete a project. FK cascade drops chats, sub_chats and project_ai_accounts.
   *
   * Aborts active executor streams BEFORE the delete so the SDK doesn't keep tool-calling
   * against rows we're about to cascade-nuke (mirrors the chats.delete fix, commit 6056c8).
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const db = getDatabase();
    const existing = await getProjectByIdLocal(db, input.id);
    if (!existing) return null;

    // Capture chats (+ worktree refs) and abort their executor streams before the FK cascade nukes the rows.
    const projectChats = await db
      .select({ id: chats.id, worktreePath: chats.worktreePath, branch: chats.branch })
      .from(chats)
      .where(eq(chats.projectId, input.id));
    if (projectChats.length > 0) {
      const subChatRows = await db
        .select({ id: subChats.id })
        .from(subChats)
        .where(
          inArray(
            subChats.chatId,
            projectChats.map((c) => c.id),
          ),
        );
      abortActiveExecutionsForSubChats(
        subChatRows.map((r) => r.id),
        'project deleted',
      );
      // Cancel the flow runs these chats drive (JSON link, no FK cascade — else they keep running).
      for (const c of projectChats) await cancelFlowRunsForChatOrThrow(c.id);
    }

    await settleChatOwnedFlowDeletion(() => deleteProjectLocal(db, input.id));
    // Frink-managed builds live under ~/.frink/builds — remove the folder too (no-op for user dirs).
    await removeManagedBuildFolder(existing.path, frinkUserHome());
    void removeProjectWorktrees(existing.path, projectChats);
    return existing;
  }),

  /**
   * Refresh git info for a project (e.g. after the user changed origin remote).
   */
  refreshGitInfo: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const project = await getProjectByIdLocal(db, input.id);
      if (!project) return null;

      const gitInfo = await getGitRemoteInfo(project.path);
      return updateProjectLocal(db, input.id, {
        gitRemoteUrl: gitInfo.normalizedUrl,
        gitProvider: gitInfo.provider,
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
      });
    }),

  /**
   * Clone a GitHub repo and create a local project.
   */
  cloneFromGitHub: publicProcedure
    .input(z.object({ repoUrl: z.string() }))
    .mutation(({ input }) => cloneGitHubRepo(input.repoUrl)),
});
