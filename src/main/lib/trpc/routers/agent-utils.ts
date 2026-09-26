import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import log from 'electron-log';
import matter from 'gray-matter';
import { type CliType, getIdeDirPriority, IDE_DIRS_PRIORITY } from '../../agents';
import { getClaudeCodeTokenById, getDefaultClaudeCodeToken } from '../../credentials';
import { getDatabase } from '../../db';
import { getProjectAiAccount, getProjectAiAccountsBatch } from '../../db/repos/project-ai-accounts';
import type { AIAccountType } from '../../db/schema';
import { getProjectIdByPath } from '../../git/security/path-validation';
import { frinkUserHome } from '../../platform/frink-home';

/** Collect agents not already seen, so an earlier (higher-priority) directory wins a name clash. */
function keepFirstByName(found: FileAgent[], seen: Set<string>, into: FileAgent[]): void {
  for (const agent of found) {
    if (seen.has(agent.name)) continue;
    seen.add(agent.name);
    into.push(agent);
  }
}

/** Narrows AIAccountType to CliType, returning undefined for non-CLI types like 'github'. */
function toCliType(type: AIAccountType): CliType | undefined {
  return type === 'claude-code' ? type : undefined;
}

/**
 * Resolve the active CLI type for a project (cursor or claude-code).
 * Looks up the project's assigned account, then checks the credential type.
 * Falls back to the default credential's type when no project-specific account is set.
 */
export async function resolveProjectCliType(projectId: string): Promise<CliType | undefined> {
  try {
    const account = await getProjectAiAccount(getDatabase(), projectId);
    if (account) {
      const cred = await getClaudeCodeTokenById(account.id);
      return toCliType(cred.type);
    }

    // No project-specific account — fall back to default credential type
    const defaultCred = await getDefaultClaudeCodeToken();
    return toCliType(defaultCred.type);
  } catch (error) {
    log.warn('[resolveProjectCliType] Failed for project', projectId, error);
    return undefined;
  }
}

/**
 * Batch-resolve CLI types for multiple projects in a single Neon query.
 * Returns a Map of projectId → CliType.
 */
export async function resolveProjectCliTypesBatch(
  projectIds: string[],
): Promise<Map<string, CliType | undefined>> {
  const result = new Map<string, CliType | undefined>();
  if (projectIds.length === 0) return result;

  try {
    const accountMap = await getProjectAiAccountsBatch(getDatabase(), projectIds);
    const defaultCred = await getDefaultClaudeCodeToken();
    const defaultCliType = toCliType(defaultCred.type);

    for (const id of projectIds) {
      const accountId = accountMap.get(id);
      if (accountId) {
        try {
          const cred = await getClaudeCodeTokenById(accountId);
          result.set(id, toCliType(cred.type));
        } catch {
          result.set(id, defaultCliType);
        }
      } else {
        result.set(id, defaultCliType);
      }
    }
  } catch (error) {
    log.warn('[resolveProjectCliTypesBatch] Failed:', error);
    // Fall back: set all to undefined
    for (const id of projectIds) {
      result.set(id, undefined);
    }
  }

  return result;
}

/**
 * Get the default CLI type from the user's default credential.
 * Async — passthrough rows resolve from the keychain at use-time, but for type-only
 * lookups (cursor vs claude-code) we still read the row asynchronously to keep one
 * code path.
 */
export async function resolveDefaultCliType(): Promise<CliType | undefined> {
  try {
    const defaultCred = await getDefaultClaudeCodeToken();
    return toCliType(defaultCred.type);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the IDE directory name for writing resources (agents/hooks/skills).
 *
 * - Project-scoped: uses the project's CLI type (`.cursor` for Cursor, `.claude` for Claude Code)
 * - User-global: always `.frink` (our own dir, always scanned by aggregated reads)
 *
 * @returns The IDE directory name (e.g. `.cursor`, `.claude`, `.frink`)
 */
export async function resolveWriteIdeDir(
  source: 'user' | 'project',
  cwd?: string,
): Promise<string> {
  if (source === 'project' && cwd) {
    const projectId = getProjectIdByPath(cwd); // also validates
    const cliType = await resolveProjectCliType(projectId);
    return getIdeDirPriority(cliType)[0];
  }
  return '.frink';
}

/**
 * Search all IDE directories to find an existing agent file.
 * Unlike `resolveWriteIdeDir` (which returns the *preferred* write dir),
 * this finds where the file *actually* lives on disk.
 *
 * @returns The absolute path to the agent file, or null if not found.
 */
export async function findExistingAgentFile(
  name: string,
  source: 'user' | 'project',
  cwd?: string,
): Promise<string | null> {
  const basePath = source === 'project' ? cwd : frinkUserHome();
  if (!basePath) return null;

  for (const ideDir of IDE_DIRS_PRIORITY) {
    const agentPath = path.join(basePath, ideDir, 'agents', `${name}.md`);
    try {
      await fs.access(agentPath);
      return agentPath;
    } catch {
      // Not in this directory, continue searching
    }
  }
  return null;
}

// Valid model values for agents
export const VALID_AGENT_MODELS = ['sonnet', 'opus', 'haiku', 'inherit'] as const;
export type AgentModel = (typeof VALID_AGENT_MODELS)[number];

// Agent definition parsed from markdown file
export type ParsedAgent = {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: AgentModel;
};

// Agent with source/path metadata
export type FileAgent = ParsedAgent & {
  source: 'user' | 'project';
  path: string;
};

/**
 * Parse agent markdown file with YAML frontmatter
 * Format:
 * ---
 * name: code-reviewer
 * description: Reviews code for quality
 * tools: Read, Glob, Grep
 * model: sonnet
 * ---
 *
 * You are a code reviewer. When invoked...
 */
export function parseAgentMd(content: string, filename: string): Partial<ParsedAgent> {
  try {
    const { data, content: body } = matter(content);

    // Parse tools - can be comma-separated string or array
    let tools: string[] | undefined;
    if (typeof data.tools === 'string') {
      tools = data.tools
        .split(',')
        .map((t: string) => t.trim())
        .filter(Boolean);
    } else if (Array.isArray(data.tools)) {
      tools = data.tools;
    }

    // Parse disallowedTools
    let disallowedTools: string[] | undefined;
    if (typeof data.disallowedTools === 'string') {
      disallowedTools = data.disallowedTools
        .split(',')
        .map((t: string) => t.trim())
        .filter(Boolean);
    } else if (Array.isArray(data.disallowedTools)) {
      disallowedTools = data.disallowedTools;
    }

    // Validate model
    const model =
      data.model && VALID_AGENT_MODELS.includes(data.model)
        ? (data.model as AgentModel)
        : undefined;

    return {
      name: typeof data.name === 'string' ? data.name : filename.replace('.md', ''),
      description: typeof data.description === 'string' ? data.description : '',
      prompt: body.trim(),
      tools,
      disallowedTools,
      model,
    };
  } catch (_err) {
    return {};
  }
}

/**
 * Generate markdown content for agent file
 */
export function generateAgentMd(agent: {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: AgentModel;
}): string {
  const frontmatter: string[] = [];
  frontmatter.push(`name: ${agent.name}`);
  frontmatter.push(`description: ${agent.description}`);
  if (agent.tools && agent.tools.length > 0) {
    frontmatter.push(`tools: ${agent.tools.join(', ')}`);
  }
  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    frontmatter.push(`disallowedTools: ${agent.disallowedTools.join(', ')}`);
  }
  if (agent.model && agent.model !== 'inherit') {
    frontmatter.push(`model: ${agent.model}`);
  }

  return `---\n${frontmatter.join('\n')}\n---\n\n${agent.prompt}`;
}

/**
 * Rebuild an agent .md from edited typed fields while PRESERVING every other
 * frontmatter key the user (or another tool) authored — `generateAgentMd` emits
 * only the typed fields, so routing an UPDATE through it silently destroys keys
 * like Cursor's `readonly:` or a custom `color:` (it stays for CREATE, where no
 * prior file exists).
 *
 * Clear semantics are caller-proof: `undefined` PRESERVES the existing value (the
 * caller didn't touch that field), while an explicit empty array / `'inherit'`
 * CLEARS it (the key is removed, never left stale). A partial-update caller can
 * therefore never silently destroy a restriction by omitting a field.
 */
export function updateAgentMd(
  existingContent: string,
  agent: {
    name: string;
    description: string;
    prompt: string;
    tools?: string[];
    disallowedTools?: string[];
    model?: AgentModel;
  },
): string {
  const data: Record<string, unknown> = {
    ...matter(existingContent).data,
    name: agent.name,
    description: agent.description,
  };
  if (agent.tools !== undefined) {
    if (agent.tools.length > 0) data.tools = agent.tools;
    else delete data.tools;
  }
  if (agent.disallowedTools !== undefined) {
    if (agent.disallowedTools.length > 0) data.disallowedTools = agent.disallowedTools;
    else delete data.disallowedTools;
  }
  if (agent.model !== undefined) {
    if (agent.model !== 'inherit') data.model = agent.model;
    else delete data.model;
  }
  return `${matter.stringify(agent.prompt, data).trimEnd()}\n`;
}

// Regex to validate agent/skill names - alphanumeric, hyphens, underscores only
const SAFE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate agent/skill name to prevent path traversal attacks
 */
export function isValidAgentName(name: string): boolean {
  return SAFE_NAME_REGEX.test(name) && !name.includes('..') && name.length <= 100;
}

/**
 * Format a resource path for display: relative for project resources, ~/... for user resources.
 */
export function formatResourceDisplayPath(
  fullPath: string,
  source: 'user' | 'project',
  basePath?: string,
): string {
  if (source === 'project' && basePath) {
    return path.relative(basePath, fullPath);
  }
  const homeDir = frinkUserHome();
  return fullPath.startsWith(homeDir) ? `~${fullPath.slice(homeDir.length)}` : fullPath;
}

/**
 * Scan directory for agent .md files
 * Format: .claude/agents/agent-name.md
 */
export async function scanAgentsDirectory(
  dir: string,
  source: 'user' | 'project',
  basePath?: string, // For project agents, cwd to make paths relative to
): Promise<FileAgent[]> {
  const agents: FileAgent[] = [];

  try {
    await fs.access(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Validate entry name for security (prevent path traversal)
      if (entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) {
        continue;
      }

      // Accept .md files (Claude Code native format)
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const agentPath = path.join(dir, entry.name);
        try {
          const content = await fs.readFile(agentPath, 'utf-8');

          // Skip Frink's own projected MIRROR copies — a mirror is never a distinct
          // source. The stamp is read from RAW frontmatter: parseAgentMd strips
          // `frinkProjected`, so checking the parsed result would never see it.
          if (matter(content).data.frinkProjected === true) continue;

          const parsed = parseAgentMd(content, entry.name);

          if (parsed.description && parsed.prompt) {
            const displayPath = formatResourceDisplayPath(agentPath, source, basePath);

            agents.push({
              name: parsed.name || entry.name.replace('.md', ''),
              description: parsed.description,
              prompt: parsed.prompt,
              tools: parsed.tools,
              disallowedTools: parsed.disallowedTools,
              model: parsed.model,
              source,
              path: displayPath,
            });
          }
        } catch (_err) {}
      }
    }
  } catch (err) {
    // Directory doesn't exist or not accessible
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    }
  }

  return agents;
}

// Cache for all agents (global + project)
const allAgentsCache = new Map<string, { agents: FileAgent[]; timestamp: number }>();
const ALL_AGENTS_CACHE_TTL = 30000; // 30 seconds

/**
 * Get ALL available agents for SDK registration
 * Scans ~/.claude/agents/ (global) and .claude/agents/ (project) directories
 * This makes agents available for Claude to use proactively via Task tool
 */
/**
 * The per-agent shape handed to the SDK's `agents:` option. `tools` AND
 * `disallowedTools` are both part of the SDK's AgentDefinition and the SDK
 * enforces them natively for Task-tool subagents — dropping either would
 * silently void a user's restriction.
 */
export type SdkAgentDefinition = {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: AgentModel;
};

export function buildSdkAgentRecord(agents: FileAgent[]): Record<string, SdkAgentDefinition> {
  const result: Record<string, SdkAgentDefinition> = {};
  for (const agent of agents) {
    result[agent.name] = {
      description: agent.description,
      prompt: agent.prompt,
      ...(agent.tools && { tools: agent.tools }),
      ...(agent.disallowedTools && { disallowedTools: agent.disallowedTools }),
      ...(agent.model && { model: agent.model }),
    };
  }
  return result;
}

export async function getAllAgentsForSdk(
  cwd?: string,
): Promise<Record<string, SdkAgentDefinition>> {
  const cacheKey = cwd || '__global__';
  const cached = allAgentsCache.get(cacheKey);
  const now = Date.now();

  // Return cached if fresh
  if (cached && now - cached.timestamp < ALL_AGENTS_CACHE_TTL) {
    return buildSdkAgentRecord(cached.agents);
  }

  // Scan both global and project directories
  const allAgents: FileAgent[] = [];
  const seenNames = new Set<string>();

  // SDK serves Claude Code, so prioritize .claude > .cursor > .frink
  const sdkDirPriority = getIdeDirPriority('claude-code');

  // 1. Project agents (higher priority)
  if (cwd) {
    for (const dir of sdkDirPriority) {
      const projectAgents = await scanAgentsDirectory(
        path.join(cwd, dir, 'agents'),
        'project',
        cwd,
      );
      keepFirstByName(projectAgents, seenNames, allAgents);
    }
  }

  // 2. Global agents (lower priority)
  const home = frinkUserHome();
  for (const dir of sdkDirPriority) {
    const globalAgents = await scanAgentsDirectory(path.join(home, dir, 'agents'), 'user');
    keepFirstByName(globalAgents, seenNames, allAgents);
  }

  // Cache result
  allAgentsCache.set(cacheKey, { agents: allAgents, timestamp: now });

  return buildSdkAgentRecord(allAgents);
}
