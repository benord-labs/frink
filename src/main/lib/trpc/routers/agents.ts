import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import log from 'electron-log';
import { z } from 'zod';
import { type AgentInfo, IDE_DIRS_PRIORITY } from '../../agents';
import {
  agentRealRoots,
  agentSourceRootsFor,
  copyUserAgent,
  resolveAgentSource,
} from '../../agents/agent-copy';
import { agentCopyDirs, BRIDGED_TOOLS, type SkillTool } from '../../agents/follows-you';
import { getDatabase } from '../../db';
import { listProjects } from '../../db/repos/projects';
import { anyCommittableDir } from '../../git/git-utils';
import type { AgentDir } from '../../provider/handlers/agent-brain';
import { publicProcedure, router } from '../index';
import {
  findExistingAgentFile,
  generateAgentMd,
  isValidAgentName,
  parseAgentMd,
  resolveWriteIdeDir,
  scanAgentsDirectory,
  updateAgentMd,
  VALID_AGENT_MODELS,
} from './agent-utils';
import { aggregatedScan } from './aggregated-scan';
import { listResources } from './list-resources';
import { changeResourceScope } from './resource-scope';
import { frinkUserHome } from '../../platform/frink-home';

/**
 * Copy ONE agent into `toolDirs` and classify: `copied` when ≥1 dir gained it (or it was already present
 * everywhere), `skipped` when every destination held a stamped mirror / hand-edit we preserved, `failed`
 * on an invalid name, an out-of-bounds/symlink-escaping source, or IO error.
 */
type AgentRoots = { allowedRoots: string[]; realRoots: string[] };

async function copyOneAgent(
  agent: { name: string; sourcePath: string },
  roots: AgentRoots,
  toolDirs: AgentDir[],
): Promise<'copied' | 'skipped' | 'failed'> {
  try {
    if (!isValidAgentName(agent.name)) throw new Error(`Invalid agent name: ${agent.name}`);
    // Real containment is resolveAgentSource (lexical + realpath); the name check above is a UX/sanity
    // guard on the displayed name, not the traversal boundary (dest = the resolved source basename).
    const sourceFile = await resolveAgentSource(
      agent.sourcePath,
      roots.allowedRoots,
      roots.realRoots,
    );
    const { wrote, kept } = await copyUserAgent(sourceFile, toolDirs);
    return wrote > 0 || kept === 0 ? 'copied' : 'skipped';
  } catch (err) {
    log.warn(`[agents.copyAcross] ${agent.name} failed: ${String(err)}`);
    return 'failed';
  }
}

/** Copy every agent and bucket the outcomes by name (copied / kept-as-skipped / failed). */
async function copyAllAgents(
  agents: { name: string; sourcePath: string }[],
  roots: AgentRoots,
  toolDirs: AgentDir[],
): Promise<{ copied: string[]; skipped: string[]; failed: string[] }> {
  const copied: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const a of agents) {
    const outcome = await copyOneAgent(a, roots, toolDirs);
    (outcome === 'copied' ? copied : outcome === 'skipped' ? skipped : failed).push(a.name);
  }
  return { copied, skipped, failed };
}

/** The AgentDir copy targets (dir + flavor) for a breadth `mode`/`activeTool` under `base`. */
function agentToolDirs(
  mode: 'portable' | 'native',
  configuredTools: SkillTool[],
  activeTool: 'claude-code' | 'cursor' | undefined,
  base: string,
): AgentDir[] {
  return agentCopyDirs(mode, configuredTools, activeTool).map((d) => ({
    dir: path.join(base, d, 'agents'),
    flavor: d === '.cursor' ? 'cursor' : 'claude',
  }));
}

// Shared procedure for listing agents
const listAgentsProcedure = publicProcedure
  .input(
    z
      .object({
        cwd: z.string().optional(),
      })
      .optional(),
  )
  .query(async ({ input }) => {
    return listResources(
      'agents',
      (dir, source) =>
        scanAgentsDirectory(dir, source, source === 'project' ? input?.cwd : undefined),
      input?.cwd,
    );
  });

export const agentsRouter = router({
  /**
   * List all agents from filesystem
   * - User agents: ~/.claude/agents/
   * - Project agents: .claude/agents/ (relative to cwd)
   */
  list: listAgentsProcedure,

  /**
   * Alias for list - used by @ mention
   */
  listEnabled: listAgentsProcedure,

  /**
   * Get single agent by name
   */
  get: publicProcedure
    .input(z.object({ name: z.string(), cwd: z.string().optional() }))
    .query(async ({ input }) => {
      if (!isValidAgentName(input.name)) {
        throw new Error('Invalid agent name');
      }
      const { cwd } = input;
      const locations = [
        ...IDE_DIRS_PRIORITY.map((d) => ({
          dir: path.join(frinkUserHome(), d, 'agents'),
          source: 'user' as const,
        })),
        ...(cwd
          ? IDE_DIRS_PRIORITY.map((d) => ({
              dir: path.join(cwd, d, 'agents'),
              source: 'project' as const,
            }))
          : []),
      ];

      for (const { dir, source } of locations) {
        const agentPath = path.join(dir, `${input.name}.md`);
        try {
          const content = await fs.readFile(agentPath, 'utf-8');
          const parsed = parseAgentMd(content, `${input.name}.md`);
          return {
            ...parsed,
            source,
            path: agentPath,
          };
        } catch {}
      }
      return null;
    }),

  /**
   * Create a new agent
   */
  create: publicProcedure
    .input(
      z.object({
        name: z.string(),
        description: z.string(),
        prompt: z.string(),
        tools: z.array(z.string()).optional(),
        disallowedTools: z.array(z.string()).optional(),
        model: z.enum(VALID_AGENT_MODELS).optional(),
        source: z.enum(['user', 'project']),
        cwd: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Validate name (kebab-case, no special chars)
      const safeName = input.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!safeName || safeName.includes('..')) {
        throw new Error('Invalid agent name');
      }

      // Determine target directory based on the project's active CLI type
      const basePath = input.source === 'project' ? input.cwd : undefined;
      if (input.source === 'project' && !basePath) {
        throw new Error('Project path (cwd) required for project agents');
      }
      const ideDir = await resolveWriteIdeDir(input.source, basePath);
      const targetDir = path.join(basePath ?? frinkUserHome(), ideDir, 'agents');

      // Ensure directory exists
      await fs.mkdir(targetDir, { recursive: true });

      const agentPath = path.join(targetDir, `${safeName}.md`);

      // Check if already exists
      try {
        await fs.access(agentPath);
        throw new Error(`Agent "${safeName}" already exists`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }

      // Generate and write file
      const content = generateAgentMd({
        name: safeName,
        description: input.description,
        prompt: input.prompt,
        tools: input.tools,
        disallowedTools: input.disallowedTools,
        model: input.model,
      });

      await fs.writeFile(agentPath, content, 'utf-8');

      return {
        name: safeName,
        path: agentPath,
        source: input.source,
      };
    }),

  /**
   * Update an existing agent
   */
  update: publicProcedure
    .input(
      z.object({
        originalName: z.string(),
        name: z.string(),
        description: z.string(),
        prompt: z.string(),
        tools: z.array(z.string()).optional(),
        disallowedTools: z.array(z.string()).optional(),
        model: z.enum(VALID_AGENT_MODELS).optional(),
        source: z.enum(['user', 'project']),
        cwd: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Validate names
      const safeOriginalName = input.originalName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const safeName = input.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!safeOriginalName || !safeName || safeName.includes('..')) {
        throw new Error('Invalid agent name');
      }

      const basePath = input.source === 'project' ? input.cwd : undefined;
      if (input.source === 'project' && !basePath) {
        throw new Error('Project path (cwd) required for project agents');
      }

      // Search all IDE directories to find the original file
      const originalPath = await findExistingAgentFile(safeOriginalName, input.source, basePath);
      if (!originalPath) {
        throw new Error(`Agent "${safeOriginalName}" not found`);
      }

      // Determine write directory for the new/updated file
      const ideDir = await resolveWriteIdeDir(input.source, basePath);
      const targetDir = path.join(basePath ?? frinkUserHome(), ideDir, 'agents');
      const newPath = path.join(targetDir, `${safeName}.md`);

      // If renaming or moving across IDE dirs, check new name doesn't already exist
      if (originalPath !== newPath) {
        try {
          await fs.access(newPath);
          throw new Error(`Agent "${safeName}" already exists`);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
          }
        }
      }

      // Rebuild from the EXISTING file so frontmatter keys the user (or another
      // tool) authored — readonly:, color:, etc. — survive the edit. A plain
      // generateAgentMd here would silently destroy them (it stays for create).
      const existingContent = await fs.readFile(originalPath, 'utf-8');
      const content = updateAgentMd(existingContent, {
        name: safeName,
        description: input.description,
        prompt: input.prompt,
        tools: input.tools,
        disallowedTools: input.disallowedTools,
        model: input.model,
      });

      // Ensure target directory exists (may differ from original's dir)
      await fs.mkdir(targetDir, { recursive: true });

      // Write new file first, then delete old — prevents data loss if write fails
      await fs.writeFile(newPath, content, 'utf-8');

      if (originalPath !== newPath) {
        await fs.unlink(originalPath);
      }

      return {
        name: safeName,
        path: newPath,
        source: input.source,
      };
    }),

  /**
   * Delete an agent
   */
  delete: publicProcedure
    .input(
      z.object({
        name: z.string(),
        source: z.enum(['user', 'project']),
        cwd: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const safeName = input.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!safeName || safeName.includes('..')) {
        throw new Error('Invalid agent name');
      }

      const basePath = input.source === 'project' ? input.cwd : undefined;
      if (input.source === 'project' && !basePath) {
        throw new Error('Project path (cwd) required for project agents');
      }

      // Search all IDE directories to find the actual file
      const agentPath = await findExistingAgentFile(safeName, input.source, basePath);
      if (!agentPath) {
        throw new Error(`Agent "${safeName}" not found`);
      }

      await fs.unlink(agentPath);

      return { deleted: true };
    }),

  /**
   * Change agent scope between global and project
   */
  changeScopeAgent: publicProcedure
    .input(
      z.object({
        agentName: z.string(),
        type: z.enum(['agent', 'skill', 'hook']),
        scope: z.enum(['global', 'project']),
        projectId: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      changeResourceScope({
        name: input.agentName,
        type: input.type,
        scope: input.scope,
        projectId: input.projectId,
      }),
    ),

  /**
   * USER-initiated "copy across" for AGENTS — copy custom agent `.md`(s) into the chosen breadth of tool
   * dirs under a target scope so the user's tools can read them. `mode` = 'portable' (the native agents
   * dir of every configured tool → Synced) or 'native' (just `activeTool`'s dir). Plain user-OWNED copies
   * (no `frinkProjected` stamp → the spawn-time auto-mirror never overwrites them); Claude-only typed
   * fields are stripped per target via the shared `crossFlavorAgentMd`; never clobbers a stamped mirror or
   * a hand-edit (those come back in `skipped`). A project target may add committable repo files — surfaced
   * via `committedRepo`, NEVER refused (provider-config-canonical-home: the user's deliberate choice).
   */
  copyAcross: publicProcedure
    .input(
      z.object({
        agents: z.array(z.object({ name: z.string(), sourcePath: z.string() })).min(1),
        target: z.enum(['global', 'project']),
        projectId: z.string().optional(),
        mode: z.enum(['portable', 'native']).default('portable'),
        activeTool: z.enum(['claude-code', 'cursor']).optional(),
      }),
    )
    .mutation(
      async ({
        input,
      }): Promise<{
        copied: string[];
        skipped: string[];
        committedRepo: boolean;
        error?: string;
      }> => {
        const projects = await listProjects(getDatabase());
        const project =
          input.target === 'project' ? projects.find((p) => p.id === input.projectId) : undefined;
        if (input.target === 'project' && !input.projectId) {
          return { copied: [], skipped: [], committedRepo: false, error: 'Project ID required' };
        }
        if (input.target === 'project' && !project) {
          return { copied: [], skipped: [], committedRepo: false, error: 'Project not found' };
        }
        const projectPath = project?.path;
        const base = projectPath ?? frinkUserHome();

        const toolDirs = agentToolDirs(input.mode, BRIDGED_TOOLS, input.activeTool, base);
        if (toolDirs.length === 0) {
          return { copied: [], skipped: [], committedRepo: false, error: 'No destination tool' };
        }

        // Renderer-supplied source paths must stay inside a known agent dir (home or a registered project).
        // realpath the roots ONCE for the whole batch (not per agent).
        const allowedRoots = [frinkUserHome(), ...projects.map((p) => p.path)].flatMap((b) =>
          agentSourceRootsFor(b),
        );
        const roots = { allowedRoots, realRoots: await agentRealRoots(allowedRoots) };

        const { copied, skipped, failed } = await copyAllAgents(input.agents, roots, toolDirs);

        // Every copy errored → surface the failure, never a false "added to the repo".
        if (copied.length === 0 && skipped.length === 0) {
          return {
            copied,
            skipped,
            committedRepo: false,
            error: `Could not copy ${failed.join(', ')}`,
          };
        }
        const committedRepo =
          projectPath != null &&
          copied.length > 0 &&
          (await anyCommittableDir(
            projectPath,
            toolDirs.map((t) => t.dir),
          ));
        return { copied, skipped, committedRepo };
      },
    ),

  /**
   * Get aggregated agent info with scope information.
   * Scans global ~/.frink/agents/ and registered projects' .frink/agents/ directories.
   * Only imported resources appear here — IDE dirs feed the discovery/import UI.
   */
  getAggregatedAgentInfo: publicProcedure.query(async (): Promise<AgentInfo[]> => {
    return aggregatedScan('agent', 'agents', scanAgentsDirectory);
  }),
});
