/**
 * Shared utility for the aggregated scan/dedup pipeline used by agents, hooks, and skills routers.
 *
 * All three routers follow the same pattern:
 * 1. Scan global IDE dirs for resources
 * 2. Scan per-project IDE dirs for resources
 * 3. Map each scanned item to AgentInfo
 */
import path from 'node:path';
import {
  type AgentInfo,
  type AgentResourceType,
  type AgentSource,
  deriveSourceFromPath,
  getIdeDirPriority,
  IDE_DIRS_PRIORITY,
  isUniversalPath,
  UNIVERSAL_DIR,
} from '../../agents';
import {
  BRIDGED_TOOLS,
  followsYouAcross,
  readableBy,
  type SkillTool,
} from '../../agents/follows-you';
import { getDatabase } from '../../db';
import { listProjects } from '../../db/repos/projects';
import { resolveProjectCliTypesBatch } from './agent-utils';
import { frinkUserHome } from '../../platform/frink-home';

/** Minimal shape that all scan functions return (FileAgent, FileHook, FileSkill all satisfy this). */
export type ScannedResource = {
  name: string;
  path: string;
  description: string;
  /** Frink-shipped first-party asset (skills only — `.baseline.json` present). */
  builtIn?: boolean;
};

/** A scan function that reads a directory and returns resources. */
type ScanFn<T extends ScannedResource> = (dir: string, source: 'user' | 'project') => Promise<T[]>;

/**
 * Generic aggregated scan pipeline.
 *
 * @param resourceType - 'agent' | 'hook' | 'skill'
 * @param dirSuffix - subdirectory name under IDE dirs (e.g. 'agents', 'hooks', 'skills')
 * @param scanDirectory - the scan function to read resources from a directory
 */
export async function aggregatedScan<T extends ScannedResource>(
  resourceType: AgentResourceType,
  dirSuffix: string,
  scanDirectory: ScanFn<T>,
): Promise<AgentInfo[]> {
  const entries: RawEntry<T>[] = [];

  // 1. Scan global IDE directories + the universal `.agents` home (the follows-you marker)
  const globalDirs = [...IDE_DIRS_PRIORITY, UNIVERSAL_DIR].map((d: string) =>
    path.join(frinkUserHome(), d, dirSuffix),
  );

  for (const globalDir of globalDirs) {
    const items = await scanDirectory(globalDir, 'user');
    for (const item of items) {
      entries.push({ item, scope: 'global' });
    }
  }

  // 2. Scan registered projects' directories (all IDE dirs, no dedup)
  try {
    const userProjects = await listProjects(getDatabase());

    // Batch-resolve CLI types for all projects in a single Neon query
    const cliTypeMap = await resolveProjectCliTypesBatch(userProjects.map((p) => p.id));

    // Scan all projects in parallel
    const projectResults = await Promise.all(
      userProjects.map(async (project) => {
        const cliType = cliTypeMap.get(project.id);
        const priorityDirs = [...getIdeDirPriority(cliType), UNIVERSAL_DIR];
        const projectDirs = priorityDirs.map((d: string) =>
          path.join(project.path, d, dirSuffix),
        );

        const items: { item: T; cliType: typeof cliType }[] = [];
        const dirResults = await Promise.all(
          projectDirs.map((dir) => scanDirectory(dir, 'project')),
        );
        for (const batch of dirResults) {
          for (const item of batch) {
            items.push({ item, cliType });
          }
        }
        return { project, items };
      }),
    );

    for (const { project, items } of projectResults) {
      for (const { item, cliType } of items) {
        entries.push({ item, scope: 'project', projectPath: project.path, cliType });
      }
    }
  } catch {
    // Neon not available — continue with global resources only
  }

  return dedupeByLogicalName(entries, resourceType, BRIDGED_TOOLS);
}

/** A scanned item plus where it came from, before grouping. */
export type RawEntry<T extends ScannedResource> = {
  item: T;
  scope: 'global' | 'project';
  projectPath?: string;
  cliType?: 'cursor' | 'claude-code';
};

/** Priority index of a path's IDE dir within `dirs` (lower = higher priority); unknown sorts last. */
function dirPriority(p: string, dirs: readonly string[]): number {
  for (let i = 0; i < dirs.length; i++) {
    if (p.includes(`/${dirs[i]}/`) || p.includes(`\\${dirs[i]}\\`)) return i;
  }
  return dirs.length;
}

/**
 * Collapse scanned items to ONE row per logical resource (same scope + project + type + name), with the
 * tool(s) it actually lives in. This is a presence fact — it asserts no sync. Divergent same-name copies
 * still collapse to one row, but every copy's path is carried in `sources` so nothing is hidden.
 */
export function dedupeByLogicalName<T extends ScannedResource>(
  entries: RawEntry<T>[],
  type: AgentResourceType,
  userTools: SkillTool[],
): AgentInfo[] {
  const groups = new Map<string, RawEntry<T>[]>();
  for (const e of entries) {
    const key = `${e.scope}|${e.projectPath ?? ''}|${type}|${e.item.name}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }

  const out: AgentInfo[] = [];
  for (const members of groups.values()) {
    // Rank by the GROUP's tool priority — for a project that's its active CLI's order, so the canonical
    // copy + first chip match the tool actually in use (and the details-sidebar's CLI filter keeps the
    // row, instead of dropping a Cursor project's copy because `.claude` outranks `.cursor` globally).
    const dirs = getIdeDirPriority(members[0].cliType);
    members.sort((a, b) => dirPriority(a.item.path, dirs) - dirPriority(b.item.path, dirs));
    out.push(buildAgentInfo(members, type, userTools));
  }
  return out;
}

/**
 * Presence chips: one entry per tool dir (priority order), EXCLUDING Frink's internal `.frink` home
 * (not a user tool). Each carries its path so the copy stays reachable in the expanded row.
 */
function presenceChips<T extends ScannedResource>(
  members: RawEntry<T>[],
  type: AgentResourceType,
): { source: AgentSource; path: string }[] {
  // Hooks are a dormant file-lister, not mirrored across tools — never chip them.
  if (type === 'hook') return [];
  const seen = new Set<AgentSource>();
  const out: { source: AgentSource; path: string }[] = [];
  for (const m of members) {
    // The universal `.agents` home is the follows-you marker, not a tool — never chip it.
    if (isUniversalPath(m.item.path)) continue;
    const source = deriveSourceFromPath(m.item.path);
    if (source === 'frink' || seen.has(source)) continue;
    seen.add(source);
    out.push({ source, path: m.item.path });
  }
  return out;
}

/**
 * The path/item to drive the collapsed row: the top presence chip's copy (a user tool, priority order)
 * if any, else the priority-primary member (covers hooks + frink-only, where `sources` is empty).
 */
function pickCanonical<T extends ScannedResource>(
  members: RawEntry<T>[],
  sources: { source: AgentSource; path: string }[],
): { path: string; item: T } {
  const path = sources[0]?.path ?? members[0].item.path;
  const item = members.find((m) => m.item.path === path)?.item ?? members[0].item;
  return { path, item };
}

/** Build the single AgentInfo for a group of same-logical-name scanned items. */
function buildAgentInfo<T extends ScannedResource>(
  members: RawEntry<T>[],
  type: AgentResourceType,
  userTools: SkillTool[],
): AgentInfo {
  const primary = members[0];
  const { scope, projectPath, cliType } = primary;
  const sources = presenceChips(members, type);
  // Read-only ONLY when no user-authored copy exists — a same-name user override stays editable.
  const builtIn = members.every((m) => m.item.builtIn === true);
  // Follows you = every configured tool can READ a copy (per the verified read-map). Hooks never bridge.
  // Agents use a DIFFERENT read-map than skills (Cursor can't read .claude/agents) — pass the kind.
  const paths = members.map((m) => m.item.path);
  const readKind = type === 'agent' ? 'agent' : 'skill';
  const followsYou = type !== 'hook' && followsYouAcross(paths, userTools, readKind);
  const reads = type === 'hook' ? [] : readableBy(paths, userTools, readKind);
  const { path: canonicalPath, item: canonical } = pickCanonical(members, sources);

  return {
    name: primary.item.name,
    type,
    config: {
      name: primary.item.name,
      type,
      source: deriveSourceFromPath(canonicalPath),
      path: canonicalPath,
      description: canonical.description,
      enabled: true,
    },
    enabled: true,
    scope,
    ...(projectPath && { projectPath }),
    path: canonicalPath,
    description: canonical.description,
    ...(cliType && { cliType }),
    builtIn,
    followsYou,
    ...(reads.length > 0 && { readableBy: reads }),
    ...(sources.length > 0 && { sources }),
  };
}
