import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import log from 'electron-log';
import matter from 'gray-matter';
import { z } from 'zod';
import { expandHomePath } from '../../../../shared/lib/expand-home';
import type { AgentInfo } from '../../agents';
import { BRIDGED_TOOLS, skillCopyDirs } from '../../agents/follows-you';
import { getDatabase } from '../../db';
import { listProjects } from '../../db/repos/projects';
import { skillTargetDirsFor } from '../../frink-skills-dir';
import { anyCommittableDir } from '../../git/git-utils';
import {
  copyUserSkill,
  isFrinkProjection,
  isFrinkShipped,
  ORPHAN_NAME,
} from '../../skills/skill-projection';
import { publicProcedure, router } from '../index';
import { formatResourceDisplayPath } from './agent-utils';
import { aggregatedScan } from './aggregated-scan';
import { listResources } from './list-resources';
import { changeResourceScope } from './resource-scope';
import { frinkUserHome } from '../../platform/frink-home';

export type FileSkill = {
  name: string;
  description: string;
  source: 'user' | 'project';
  path: string;
  /** Frink-shipped first-party skill (carries `.baseline.json`) — read-only, auto-restores. */
  builtIn?: boolean;
};

/**
 * Frink's internal skill debris left in `~/.frink/skills` by the provisioner /
 * projector (staging copies, version backups, rejected drops). These carry a
 * SKILL.md + `.baseline.json` so they must be excluded from the displayed list.
 * Reuses `ORPHAN_NAME` (the projector's debris grammar) + the provisioner's
 * staging/rejected names.
 */
function isSkillDebris(name: string): boolean {
  return (
    name.startsWith('.staging-') || // provisioner staging dir
    ORPHAN_NAME.test(name) || // projector copyInto/replaceDir debris
    name.endsWith('-rejected') // provisioner rejected drop
  );
}

/**
 * Parse SKILL.md frontmatter to extract name and description
 */
function parseSkillMd(content: string): { name?: string; description?: string } {
  try {
    const { data } = matter(content);
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
    };
  } catch (_err) {
    return {};
  }
}

/**
 * Scan a directory for SKILL.md files
 */
export async function scanSkillsDirectory(
  dir: string,
  source: 'user' | 'project',
  basePath?: string, // For project skills, cwd to make paths relative to
): Promise<FileSkill[]> {
  const skills: FileSkill[] = [];

  try {
    // Check if directory exists
    try {
      await fs.access(dir);
    } catch {
      return skills;
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Support symlinked skill directories as well as regular directories.
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          const targetPath = path.join(dir, entry.name);
          const stat = await fs.stat(targetPath);
          isDir = stat.isDirectory();
        } catch {
          // Broken or inaccessible symlink target - skip it safely.
          continue;
        }
      }
      if (!isDir) continue;

      // Validate entry name for security (prevent path traversal)
      if (entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) {
        continue;
      }

      // Skip Frink's internal debris (staging/backup/rejected copies).
      if (isSkillDebris(entry.name)) continue;

      const skillDir = path.join(dir, entry.name);

      // Skip Frink's own projected MIRROR copies — a mirror is never a distinct
      // source; the canonical/origin is scanned separately. (Mirrors carry the
      // provenance marker; the ~/.frink canonical does not.)
      if (isFrinkProjection(skillDir)) continue;

      const skillMdPath = path.join(skillDir, 'SKILL.md');

      try {
        await fs.access(skillMdPath);
        const content = await fs.readFile(skillMdPath, 'utf-8');
        const parsed = parseSkillMd(content);

        const displayPath = formatResourceDisplayPath(skillMdPath, source, basePath);

        skills.push({
          name: parsed.name || entry.name,
          description: parsed.description || '',
          source,
          path: displayPath,
          builtIn: isFrinkShipped(skillDir),
        });
      } catch (_err) {
        // Skill directory doesn't have SKILL.md or read failed - skip it
      }
    }
  } catch (_err) {}

  return skills;
}

/**
 * The skills list carries the DISPLAY path of a skill (tilde-abbreviated, pointing at its SKILL.md);
 * `copyUserSkill` needs the absolute skill DIRECTORY. Expand `~` and step up from the SKILL.md file to
 * its folder. A path that is already an absolute directory (the spawn-time un-bridged detector) passes
 * through unchanged.
 */
function resolveSkillSourceDir(sourcePath: string): string {
  const expanded = expandHomePath(sourcePath);
  return path.basename(expanded) === 'SKILL.md' ? path.dirname(expanded) : expanded;
}

/**
 * `sourcePath` is renderer-supplied and flows into a recursive `cp` READ — so it MUST stay inside a known
 * skill root (a tool `skills` dir under the home dir or a registered project). Without this a crafted path
 * (`../`, absolute `/etc`, `~/.ssh`) could copy arbitrary directories into an agent-readable skill dir.
 * Pure (path math only); throws on an out-of-bounds source.
 */
function resolveAllowedSkillSource(sourcePath: string, allowedRoots: string[]): string {
  const dir = path.resolve(resolveSkillSourceDir(sourcePath));
  if (!allowedRoots.some((root) => dir === root || dir.startsWith(root + path.sep))) {
    throw new Error('source is outside the allowed skill directories');
  }
  return dir;
}

/**
 * Copy one skill into `toolDirs` and classify the outcome: `copied` when ≥1 dir gained it (or it was
 * already present everywhere — a no-op still "followed"), `skipped` when every destination held a
 * hand-edited copy we preserved, `failed` on a guarded/out-of-bounds source or IO error.
 */
async function copyOneSkill(
  skill: { name: string; sourcePath: string },
  allowedRoots: string[],
  toolDirs: string[],
): Promise<'copied' | 'skipped' | 'failed'> {
  try {
    const sourceDir = resolveAllowedSkillSource(skill.sourcePath, allowedRoots);
    const { wrote, kept } = await copyUserSkill(skill.name, sourceDir, toolDirs);
    return wrote > 0 || kept === 0 ? 'copied' : 'skipped';
  } catch (err) {
    log.warn(`[skills.copyAcross] ${skill.name} failed: ${String(err)}`);
    return 'failed';
  }
}

// Shared procedure for listing skills
const listSkillsProcedure = publicProcedure
  .input(
    z
      .object({
        cwd: z.string().optional(),
      })
      .optional(),
  )
  .query(async ({ input }) => {
    return listResources(
      'skills',
      (dir, source) =>
        scanSkillsDirectory(dir, source, source === 'project' ? input?.cwd : undefined),
      input?.cwd,
    );
  });

export const skillsRouter = router({
  /**
   * List all skills from filesystem
   * - User skills: ~/.claude/skills/
   * - Project skills: .claude/skills/ (relative to cwd)
   */
  list: listSkillsProcedure,

  /**
   * Alias for list - used by @ mention
   */
  listEnabled: listSkillsProcedure,

  /**
   * Change skill scope between global and project
   */
  changeScopeSkill: publicProcedure
    .input(
      z.object({
        skillName: z.string(),
        scope: z.enum(['global', 'project']),
        projectId: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      changeResourceScope({
        name: input.skillName,
        type: 'skill',
        scope: input.scope,
        projectId: input.projectId,
      }),
    ),

  /**
   * USER-initiated "copy across": copy skill(s) into the chosen breadth of tool dirs under a target scope
   * so the user's tools can read them. `mode` = 'portable' (.agents + the native dir of every configured
   * tool that can't read .agents → "Synced") or 'native' (just `activeTool`'s own dir). Plain user-OWNED
   * copies (no Frink marker); never clobbers a hand-edited target (those names come back in `skipped`). A
   * `project` target may add committable repo files — surfaced via `committedRepo`, NEVER refused
   * (provider-config-canonical-home: the user's deliberate choice).
   */
  copyAcross: publicProcedure
    .input(
      z.object({
        skills: z.array(z.object({ name: z.string(), sourcePath: z.string() })).min(1),
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

        const toolDirs = skillCopyDirs(input.mode, BRIDGED_TOOLS, input.activeTool).map((d) =>
          path.join(projectPath ?? frinkUserHome(), d, 'skills'),
        );
        if (toolDirs.length === 0) {
          return { copied: [], skipped: [], committedRepo: false, error: 'No destination tool' };
        }

        // Renderer-supplied source paths must stay inside a known skill root (home or a registered project).
        const allowedRoots = [frinkUserHome(), ...projects.map((p) => p.path)].flatMap((b) =>
          skillTargetDirsFor(b),
        );
        const copied: string[] = [];
        const skipped: string[] = [];
        const failed: string[] = [];
        for (const s of input.skills) {
          const outcome = await copyOneSkill(s, allowedRoots, toolDirs);
          (outcome === 'copied' ? copied : outcome === 'skipped' ? skipped : failed).push(s.name);
        }

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
          (await anyCommittableDir(projectPath, toolDirs));
        return { copied, skipped, committedRepo };
      },
    ),

  /**
   * Get aggregated skill info with scope information.
   * Scans global ~/.frink/skills/ and registered projects' .frink/skills/ directories.
   * Only imported resources appear here — IDE dirs feed the discovery/import UI.
   */
  getAggregatedSkillInfo: publicProcedure.query(async (): Promise<AgentInfo[]> => {
    return aggregatedScan('skill', 'skills', scanSkillsDirectory);
  }),
});
