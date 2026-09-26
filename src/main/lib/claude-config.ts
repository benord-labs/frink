/**
 * Helpers for reading and writing ~/.claude.json configuration
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import { eq } from 'drizzle-orm';
import log from 'electron-log';
import { isManagedBuildPath } from './builds-path';
import { getDatabase } from './db';
import { projects } from './db/schema';
import { sanitizeProjectName } from './git/worktree-naming';
import {
  DEFAULT_WORKTREE_BASE_PATH,
  resolveWorktreeBasePathSync,
} from './worktree/base-path-config';
import { getMatchedWorktreeBasePath as matchWorktreeBasePath } from './worktree/path-matcher';
import { frinkUserHome } from './platform/frink-home';

const LEADING_SLASH_REGEX = /^\//;

// Cache slug→projectPath mapping to avoid repeated full-table scans.
// Stores null for ambiguous slugs (collision) to prevent wrong-project resolution.
/* eslint-disable prefer-const */
let slugCacheExpiry = 0;
let slugCache: Map<string, string | null> = new Map();
const configMutex = new Mutex();

export const CLAUDE_CONFIG_PATH = path.join(frinkUserHome(), '.claude.json');

export type McpServerConfig = {
  command?: string;
  args?: string[];
  url?: string;
  authType?: 'oauth' | 'bearer' | 'none';
  _oauth?: {
    accessToken: string;
    refreshToken?: string;
    clientId?: string;
    expiresAt?: number;
  };
  [key: string]: unknown;
};

export type ProjectConfig = {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
};

export type ClaudeConfig = {
  mcpServers?: Record<string, McpServerConfig>; // User-scope (global) MCP servers
  projects?: Record<string, ProjectConfig>;
  [key: string]: unknown;
};

/**
 * Read ~/.claude.json asynchronously
 * Returns empty config if file doesn't exist or is invalid
 */
export async function readClaudeConfig(): Promise<ClaudeConfig> {
  try {
    const content = await fs.readFile(CLAUDE_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Read ~/.claude.json synchronously
 * Returns empty config if file doesn't exist or is invalid
 */
function _readClaudeConfigSync(): ClaudeConfig {
  try {
    const content = readFileSync(CLAUDE_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Write ~/.claude.json asynchronously
 */
export async function writeClaudeConfig(config: ClaudeConfig): Promise<void> {
  await fs.writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Execute a read-modify-write operation on ~/.claude.json atomically.
 * Prevents concurrent writes from clobbering each other.
 */
export async function updateClaudeConfigAtomic(
  updater: (config: ClaudeConfig) => ClaudeConfig | Promise<ClaudeConfig>,
): Promise<ClaudeConfig> {
  return configMutex.runExclusive(async () => {
    const config = await readClaudeConfig();
    const updatedConfig = await updater(config);
    await writeClaudeConfig(updatedConfig);
    return updatedConfig;
  });
}

/**
 * Write ~/.claude.json synchronously
 */
function _writeClaudeConfigSync(config: ClaudeConfig): void {
  writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Check if ~/.claude.json exists
 */
function _claudeConfigExists(): boolean {
  return existsSync(CLAUDE_CONFIG_PATH);
}

/**
 * Get MCP servers config for a specific project
 * Automatically resolves worktree paths to original project paths
 */
export function getProjectMcpServers(
  config: ClaudeConfig,
  projectPath: string,
): Record<string, McpServerConfig> | undefined {
  const resolvedPath = resolveProjectPathFromWorktree(projectPath) || projectPath;
  return config.projects?.[resolvedPath]?.mcpServers;
}

// Special marker for global MCP servers (not tied to a project)
export const GLOBAL_MCP_PATH = '__global__';

/**
 * Get a specific MCP server config
 * Use projectPath = GLOBAL_MCP_PATH (or null) for global MCP servers
 * Automatically resolves worktree paths to original project paths
 */
export function getMcpServerConfig(
  config: ClaudeConfig,
  projectPath: string | null,
  serverName: string,
): McpServerConfig | undefined {
  // Global MCP servers (root level mcpServers in ~/.claude.json)
  if (!projectPath || projectPath === GLOBAL_MCP_PATH) {
    return config.mcpServers?.[serverName];
  }
  // Project-specific MCP servers (resolve worktree paths)
  const resolvedPath = resolveProjectPathFromWorktree(projectPath) || projectPath;
  return config.projects?.[resolvedPath]?.mcpServers?.[serverName];
}

/**
 * Update MCP server config (creates path if needed)
 * Use projectPath = GLOBAL_MCP_PATH (or null) for global MCP servers
 * Automatically resolves worktree paths to original project paths
 */
export function updateMcpServerConfig(
  config: ClaudeConfig,
  projectPath: string | null,
  serverName: string,
  update: Partial<McpServerConfig>,
): ClaudeConfig {
  // Global MCP servers (root level mcpServers in ~/.claude.json)
  if (!projectPath || projectPath === GLOBAL_MCP_PATH) {
    config.mcpServers = config.mcpServers || {};
    config.mcpServers[serverName] = {
      ...config.mcpServers[serverName],
      ...update,
    };
    return config;
  }
  // Project-specific MCP servers (resolve worktree paths)
  const resolvedPath = resolveProjectPathFromWorktree(projectPath) || projectPath;
  config.projects = config.projects || {};
  config.projects[resolvedPath] = config.projects[resolvedPath] || {};
  config.projects[resolvedPath].mcpServers = config.projects[resolvedPath].mcpServers || {};
  config.projects[resolvedPath].mcpServers[serverName] = {
    ...config.projects[resolvedPath].mcpServers[serverName],
    ...update,
  };
  return config;
}

/**
 * Remove an MCP server from config
 * Use projectPath = GLOBAL_MCP_PATH (or null) for global MCP servers
 * Automatically resolves worktree paths to original project paths
 */
export function removeMcpServerConfig(
  config: ClaudeConfig,
  projectPath: string | null,
  serverName: string,
): ClaudeConfig {
  if (!projectPath || projectPath === GLOBAL_MCP_PATH) {
    if (config.mcpServers?.[serverName]) {
      delete config.mcpServers[serverName];
    }
    return config;
  }
  const resolvedPath = resolveProjectPathFromWorktree(projectPath) || projectPath;
  if (config.projects?.[resolvedPath]?.mcpServers?.[serverName]) {
    delete config.projects[resolvedPath].mcpServers[serverName];
    if (Object.keys(config.projects[resolvedPath].mcpServers).length === 0) {
      delete config.projects[resolvedPath].mcpServers;
    }
    if (Object.keys(config.projects[resolvedPath]).length === 0) {
      delete config.projects[resolvedPath];
    }
  }
  return config;
}

/**
 * Resolve original project path from a worktree path.
 * Supports legacy (~/.frink/worktrees/{projectId}/{chatId}/) and
 * human-readable (~/.frink/worktrees/{projectSlug}/{worktreeFolder}/) formats.
 *
 * @param pathToResolve - Either a worktree path or regular project path
 * @returns The original project path, or the input if not a worktree, or null if resolution fails
 */
export function resolveProjectPathFromWorktree(pathToResolve: string): string | null {
  // Normalize for cross-platform (handle both / and \ separators)
  const normalizedPath = pathToResolve.replace(/\\/g, '/');
  const matchedBase = getMatchedWorktreeBasePath(normalizedPath);

  if (!matchedBase) {
    // Not a recognized worktree path, return as-is
    return pathToResolve;
  }

  try {
    // Extract path segments from worktree structure
    // Path format: /Users/.../.frink/worktrees/{projectSlug}/{worktreeFolder}
    const relativePath = normalizedPath.replace(matchedBase, '').replace(LEADING_SLASH_REGEX, '');

    const parts = relativePath.split('/');
    if (parts.length < 1 || !parts[0]) {
      return null;
    }

    const db = getDatabase();

    // Strategy 1 (legacy): top-level folder is projectId.
    const projectById = db
      .select({ path: projects.path })
      .from(projects)
      .where(eq(projects.id, parts[0]))
      .get();

    if (projectById) {
      return projectById.path;
    }

    // Strategy 2 (human-readable): match projectSlug against local project names.
    // Note: chats live in Neon (not local SQLite), so we resolve via project name instead.
    // Uses a short-lived cache to avoid full-table scans on repeated calls.
    const now = Date.now();
    if (now > slugCacheExpiry) {
      slugCache = new Map();
      const allProjects = db
        .select({ name: projects.name, projectPath: projects.path })
        .from(projects)
        .all();
      const homeDir = frinkUserHome();
      for (const p of allProjects) {
        // Skip gitless builds: they have no worktrees, so they never belong in this resolution
        // cache — and their free-form LLM display names could otherwise collide with (and disable
        // resolution for) a real git project's slug.
        if (p.name && !isManagedBuildPath(p.projectPath, homeDir)) {
          const slug = sanitizeProjectName(p.name);
          const existing = slugCache.get(slug);
          if (existing === undefined) {
            slugCache.set(slug, p.projectPath);
          } else if (existing !== null) {
            log.warn(
              `[claude-config] Slug collision: "${slug}" matches multiple projects — resolution disabled for this slug`,
            );
            slugCache.set(slug, null); // Mark ambiguous — don't guess
          }
        }
      }
      slugCacheExpiry = now + 10_000; // 10s TTL
    }

    const cachedPath = slugCache.get(parts[0]);
    if (cachedPath) {
      return cachedPath;
    }

    return null;
  } catch {
    return null;
  }
}

export function getMatchedWorktreeBasePath(pathToResolve: string): string | null {
  const configuredBasePath = resolveWorktreeBasePathSync();
  return matchWorktreeBasePath(pathToResolve, configuredBasePath, DEFAULT_WORKTREE_BASE_PATH);
}
