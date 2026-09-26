import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { AgentInfo } from '../../agents';
import { publicProcedure, router } from '../index';
import { aggregatedScan } from './aggregated-scan';
import { listResources } from './list-resources';
import { changeResourceScope } from './resource-scope';

export type FileHook = {
  name: string;
  description: string;
  source: 'user' | 'project';
  path: string;
  extension: string;
};

// Regex for extracting description from comment lines (defined at top level for performance)
const COMMENT_PREFIX_REGEX = /^(?:#|\/\/|\*|\/\*)\s*/;
const SHEBANG_REGEX = /^#!/;
const COMMENT_SUFFIX_REGEX = /\*\/$/;

function getHookScriptType(extension: string): string {
  switch (extension) {
    case '.sh':
      return 'Shell';
    case '.js':
      return 'JavaScript';
    case '.ts':
      return 'TypeScript';
    case '.mjs':
      return 'JavaScript module';
    default:
      return 'Script';
  }
}

function getHookFallbackDescription(hookPath: string, extension: string): string {
  const fileName = path.basename(hookPath);
  return `${getHookScriptType(extension)} hook (${fileName})`;
}

function extractHookDescription(content: string): string | null {
  const lines = content.split('\n').slice(0, 20);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (SHEBANG_REGEX.test(trimmed)) continue;

    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
    ) {
      const cleaned = trimmed
        .replace(COMMENT_PREFIX_REGEX, '')
        .replace(COMMENT_SUFFIX_REGEX, '')
        .trim();
      if (!cleaned) continue;
      return cleaned;
    }
  }

  return null;
}

/**
 * Scan a directory for hook files (.sh, .js, .ts, .mjs)
 */
export async function scanHooksDirectory(
  dir: string,
  source: 'user' | 'project',
): Promise<FileHook[]> {
  const hooks: FileHook[] = [];

  try {
    // Check if directory exists
    try {
      await fs.access(dir);
    } catch {
      return hooks;
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      // Validate entry name for security (prevent path traversal)
      if (entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) {
        continue;
      }

      // Check for valid hook extensions
      const ext = path.extname(entry.name);
      if (!['.sh', '.js', '.ts', '.mjs'].includes(ext)) {
        continue;
      }

      const hookPath = path.join(dir, entry.name);
      const name = path.basename(entry.name, ext);

      try {
        // Try to extract a meaningful comment description from the top of the script.
        const content = await fs.readFile(hookPath, 'utf-8');
        const description = extractHookDescription(content);

        hooks.push({
          name,
          description: description || getHookFallbackDescription(hookPath, ext),
          source,
          path: hookPath,
          extension: ext,
        });
      } catch (_err) {
        // Read failed - skip it
      }
    }
  } catch (_err) {}

  return hooks;
}

// Shared procedure for listing hooks
const listHooksProcedure = publicProcedure
  .input(
    z
      .object({
        cwd: z.string().optional(),
      })
      .optional(),
  )
  .query(async ({ input }) => {
    return listResources('hooks', scanHooksDirectory, input?.cwd);
  });

export const hooksRouter = router({
  /**
   * List all hooks from filesystem
   * - User hooks: ~/.claude/hooks/
   * - Project hooks: .claude/hooks/ (relative to cwd)
   */
  list: listHooksProcedure,

  /**
   * Alias for list
   */
  listEnabled: listHooksProcedure,

  /**
   * Change hook scope between global and project
   */
  changeScopeHook: publicProcedure
    .input(
      z.object({
        hookName: z.string(),
        scope: z.enum(['global', 'project']),
        projectId: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      changeResourceScope({
        name: input.hookName,
        type: 'hook',
        scope: input.scope,
        projectId: input.projectId,
      }),
    ),

  /**
   * Get aggregated hook info with scope information.
   * Scans global ~/.frink/hooks/ and registered projects' .frink/hooks/ directories.
   * Only imported resources appear here — IDE dirs feed the discovery/import UI.
   */
  getAggregatedHookInfo: publicProcedure.query(async (): Promise<AgentInfo[]> => {
    return aggregatedScan('hook', 'hooks', scanHooksDirectory);
  }),
});
