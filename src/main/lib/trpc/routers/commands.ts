import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { VALID_COMMAND_NAME } from '../../../../shared/lib/command-name';
import {
  buildCommandMd,
  cleanEmptyAncestors,
  commandNameToRelPath,
  getCommandContent,
  getCommandFull,
  getCommandsRoot,
  isCommandPath,
  listCommands,
} from '../../commands';
import { publicProcedure, router } from '../index';
import { frinkUserHome } from '../../platform/frink-home';

export const commandsRouter = router({
  /**
   * List all commands from filesystem (frink/cursor/claude, project + user-global),
   * deduped by name with frink > cursor > claude, project > user priority.
   */
  list: publicProcedure
    .input(z.object({ projectPath: z.string().optional() }).optional())
    .query(async ({ input }) => listCommands(input?.projectPath)),

  /** Get a command file body (frontmatter stripped). */
  getContent: publicProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ input }) => ({ content: await getCommandContent(input.path) })),

  /** Get a command file with frontmatter parsed (used by the command editor). */
  getFull: publicProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ input }) => getCommandFull(input.path)),

  /**
   * Create a new Frink command (.md file with optional frontmatter)
   */
  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        content: z.string().min(1).max(50_000),
        scope: z.enum(['user', 'project']),
        projectPath: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { name, description, content, scope, projectPath } = input;

      if (!VALID_COMMAND_NAME.test(name)) {
        throw new Error(
          'Invalid command name. Use letters, numbers, hyphens, underscores, and colons (for namespaces).',
        );
      }

      // Resolve target directory based on scope
      const baseDir =
        scope === 'project' && projectPath
          ? path.join(projectPath, '.frink', 'commands')
          : path.join(frinkUserHome(), '.frink', 'commands');

      // Support namespaced names (git:commit -> git/commit.md)
      const relativePath = commandNameToRelPath(name);
      const filePath = `${path.join(baseDir, relativePath)}.md`;

      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      await fs.mkdir(parentDir, { recursive: true });

      // Check for existing file to prevent overwrite
      try {
        await fs.access(filePath);
        throw new Error(`Command "${name}" already exists`);
      } catch (err: unknown) {
        // ENOENT is expected (file doesn't exist), any other error should propagate
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }

      const fileContent = buildCommandMd({ description, content });
      await fs.writeFile(filePath, fileContent, 'utf-8');

      return { path: filePath, name };
    }),

  /**
   * Update an existing command file (rewrites content + frontmatter).
   * Renames via optional `newName` — moves the .md file (namespace colons
   * become directories). fs.rename handles case-only renames natively.
   */
  update: publicProcedure
    .input(
      z.object({
        path: z.string(),
        newName: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        content: z.string().min(1).max(50_000),
      }),
    )
    .mutation(async ({ input }) => {
      // Security: prevent path traversal and restrict to command directories
      if (input.path.includes('..') || !(await isCommandPath(input.path))) {
        throw new Error('Invalid path');
      }

      const fileContent = buildCommandMd({
        description: input.description,
        content: input.content,
      });

      const root = input.newName ? getCommandsRoot(input.path) : null;

      // No rename (or name unchanged): rewrite content in place
      if (input.newName && root) {
        if (!VALID_COMMAND_NAME.test(input.newName)) {
          throw new Error(
            'Invalid command name. Use letters, numbers, hyphens, underscores, and colons (for namespaces).',
          );
        }

        // Support namespaced names (git:commit -> git/commit.md)
        const relativePath = commandNameToRelPath(input.newName);
        const newPath = `${path.join(root, relativePath)}.md`;

        if (newPath !== input.path) {
          await fs.mkdir(path.dirname(newPath), { recursive: true });

          // Reject overwriting a *different* existing command. A case-only rename on
          // a case-insensitive filesystem resolves to the same file (same inode) —
          // allow it; fs.rename performs the case change natively. Comparing names
          // with toLowerCase() is unsafe: on a case-sensitive FS (Linux) it would
          // treat two distinct files as "case-only" and silently clobber the target.
          const existing = await fs.stat(newPath).catch(() => null);
          if (existing) {
            const current = await fs.stat(input.path);
            if (existing.ino !== current.ino || existing.dev !== current.dev) {
              throw new Error(`Command "${input.newName}" already exists`);
            }
          }

          await fs.writeFile(input.path, fileContent, 'utf-8');
          await fs.rename(input.path, newPath);
          await cleanEmptyAncestors(path.dirname(input.path), root);

          return { path: newPath };
        }
      } else if (input.newName && !root) {
        throw new Error('Could not determine commands root');
      }

      await fs.writeFile(input.path, fileContent, 'utf-8');
      return { path: input.path };
    }),

  /**
   * Delete a command file
   */
  delete: publicProcedure.input(z.object({ path: z.string() })).mutation(async ({ input }) => {
    // Security: prevent path traversal and restrict to command directories
    if (input.path.includes('..') || !(await isCommandPath(input.path))) {
      throw new Error('Invalid path');
    }

    const root = getCommandsRoot(input.path);

    await fs.unlink(input.path);
    if (root) {
      await cleanEmptyAncestors(path.dirname(input.path), root);
    }

    return { path: input.path };
  }),
});
