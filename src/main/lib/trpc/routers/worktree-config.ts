import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase, projects } from '../../db';
import {
  detectWorktreeConfig,
  getAvailableConfigPaths,
  UNREADABLE_CONFIG_MESSAGE,
  updateWorktreeConfig,
} from '../../git/worktree-config';
import {
  isAbsoluteWorktreeBasePathInput,
  isSensitiveWorktreeBasePath,
  normalizeWorktreeBasePath,
} from '../../worktree/base-path-validation';
import { publicProcedure, publicProcedureRaw, router } from '../index';

const WorktreeConfigPatchSchema = z.object({
  'setup-worktree': z.array(z.string()).optional(),
  'worktree-base-path': z.string().max(1000).optional(),
});

export async function resolveLocalProjectOrThrow(projectId: string) {
  const db = getDatabase();
  const localProject = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (localProject) {
    if (localProject.path.startsWith('virtual://folders/')) {
      throw new Error('Folder settings are read-only in this view');
    }
    return localProject;
  }

  // Single-machine local-first: if it's not local, it doesn't exist for this user.
  // Pre-migration this branch fell through to a cloud lookup that distinguished
  // "owned-but-on-another-machine" from "doesn't exist" — both collapse to "not found"
  // now.
  throw new Error('Project not found');
}

export const worktreeConfigRouter = router({
  /**
   * Get worktree config for a project
   * Detects from available project worktree config files
   *
   * `publicProcedureRaw`: the returned `config` is the worktree file verbatim, whose keys are
   * kebab-case (`setup-worktree`). `caseConvertOutput` recurses into nested objects and rewrites
   * `-` as well as `_`, so under `publicProcedure` the renderer would read `setup-worktree` as
   * `undefined` while still type-checking. See decision `flows-ipc-casing-contract`.
   */
  get: publicProcedureRaw.input(z.object({ projectId: z.string() })).query(async ({ input }) => {
    const project = await resolveLocalProjectOrThrow(input.projectId);

    const detected = await detectWorktreeConfig(project.path);
    if (detected.unreadable) throw new Error(UNREADABLE_CONFIG_MESSAGE);
    const available = await getAvailableConfigPaths(project.path);

    return {
      config: detected.config,
      path: detected.path,
      source: detected.source,
      available,
      projectPath: project.path,
    };
  }),

  /**
   * Change keys of a project's worktree config; keys not in `patch` are left as they are.
   */
  save: publicProcedure
    .input(z.object({ projectId: z.string(), patch: WorktreeConfigPatchSchema }))
    .mutation(async ({ input }) => {
      const project = await resolveLocalProjectOrThrow(input.projectId);
      const maybeBasePath = input.patch['worktree-base-path'];
      if (maybeBasePath?.trim()) {
        if (!isAbsoluteWorktreeBasePathInput(maybeBasePath)) {
          throw new Error('Project worktree base path must be absolute');
        }
        if (isSensitiveWorktreeBasePath(normalizeWorktreeBasePath(maybeBasePath))) {
          throw new Error('Project worktree base path cannot be a sensitive system location');
        }
      }

      try {
        return await updateWorktreeConfig(project.path, input.patch);
      } catch (error) {
        // A failed write leaves commands the form still shows unsaved, so capture it. The lazy
        // import keeps @sentry/electron out of this module's static graph.
        void import('../../sentry/init')
          .then(({ captureMainException }) => {
            captureMainException(error, { surface: 'worktree-config-save' });
          })
          .catch(() => {});
        throw error;
      }
    }),

  /**
   * Get available config paths for a project
   */
  getAvailablePaths: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const project = await resolveLocalProjectOrThrow(input.projectId);

      return getAvailableConfigPaths(project.path);
    }),
});
