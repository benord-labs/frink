/**
 * Native MCP source scanner.
 *
 * Reads `~/.claude.json` (global), `~/.cursor/mcp.json` (global), and each
 * registered project's `<project>/.cursor/mcp.json`, and emits a flat list
 * of provider-neutral `ImportCandidate` records. Filters out Frink's own
 * injected `frink_dynamic_chat` entry.
 *
 * Out of scope: per-project Claude MCPs from `~/.claude.json` `projects.*`
 * blocks (Frink's own per-project model is enablement-by-name from globals,
 * not a full per-project store; deferred to a follow-up).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FRINK_OWNED_MCP_SERVERS } from '../../../shared/lib/mcp-tool-name';
import { type McpServerConfig, readClaudeConfig } from '../claude-config';
import { frinkUserHome } from '../platform/frink-home';

/**
 * Keys Frink writes into native configs to point those tools at its own
 * MCP proxy. Must NEVER be imported back into Frink — would create a loop.
 * Single source of truth: `FRINK_OWNED_MCP_SERVERS` (also drives the
 * permission-gate auto-allow in `permissions/v2/check.ts`).
 */
const FRINK_LOOPBACK_KEYS = FRINK_OWNED_MCP_SERVERS;

export type ImportSource = 'claude-global' | 'cursor-global' | 'cursor-project';

type ImportCandidateCredentials = {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: {
    accessToken: string;
    refreshToken?: string;
    clientId?: string;
    expiresAt?: number;
  };
};

export type ImportCandidate = {
  name: string;
  source: ImportSource;
  sourcePath: string;
  /** Set only for `cursor-project` candidates */
  projectPath?: string;
  config: McpServerConfig;
  credentials: ImportCandidateCredentials;
};

const GLOBAL_CURSOR_MCP_PATH = path.join(frinkUserHome(), '.cursor', 'mcp.json');

/**
 * Extracts credentials from a raw native `McpServerConfig`. Native shapes
 * place env vars / headers / OAuth tokens in heterogeneous locations
 * (Claude uses `_oauth`; Cursor stores `env`/`headers` directly), so we
 * normalize them into a single shape here.
 */
function extractCredentials(config: McpServerConfig): ImportCandidateCredentials {
  const creds: ImportCandidateCredentials = {};

  const envField = config.env;
  if (envField && typeof envField === 'object') {
    creds.env = { ...(envField as Record<string, string>) };
  }

  const headersField = config.headers;
  if (headersField && typeof headersField === 'object') {
    creds.headers = { ...(headersField as Record<string, string>) };
  }

  if (config._oauth?.accessToken) {
    creds.oauth = {
      accessToken: config._oauth.accessToken,
      refreshToken: config._oauth.refreshToken,
      clientId: config._oauth.clientId,
      expiresAt: config._oauth.expiresAt,
    };
  }

  return creds;
}

type RawMcpFile = {
  mcpServers?: Record<string, McpServerConfig>;
};

async function readJsonOrEmpty(filePath: string): Promise<RawMcpFile> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as RawMcpFile;
  } catch {
    return {};
  }
}

function entriesToCandidates(
  servers: Record<string, McpServerConfig> | undefined,
  source: ImportSource,
  sourcePath: string,
  projectPath?: string,
): ImportCandidate[] {
  if (!servers) return [];
  const out: ImportCandidate[] = [];
  for (const [name, config] of Object.entries(servers)) {
    if (FRINK_LOOPBACK_KEYS.has(name)) continue;
    out.push({
      name,
      source,
      sourcePath,
      projectPath,
      config,
      credentials: extractCredentials(config),
    });
  }
  return out;
}

export async function scanNativeMcpSources(): Promise<ImportCandidate[]> {
  const claudeConfig = await readClaudeConfig();
  const candidates: ImportCandidate[] = [
    ...entriesToCandidates(
      claudeConfig.mcpServers,
      'claude-global',
      path.join(frinkUserHome(), '.claude.json'),
    ),
  ];

  const cursorGlobal = await readJsonOrEmpty(GLOBAL_CURSOR_MCP_PATH);
  candidates.push(
    ...entriesToCandidates(cursorGlobal.mcpServers, 'cursor-global', GLOBAL_CURSOR_MCP_PATH),
  );

  // Per-project Cursor MCPs, from the registered projects in local SQLite.
  try {
    const { getDatabase } = await import('../db');
    const { listProjects } = await import('../db/repos/projects');
    const userProjects = await listProjects(getDatabase());
    for (const project of userProjects) {
      const projectMcpPath = path.join(project.path, '.cursor', 'mcp.json');
      const file = await readJsonOrEmpty(projectMcpPath);
      candidates.push(
        ...entriesToCandidates(file.mcpServers, 'cursor-project', projectMcpPath, project.path),
      );
    }
  } catch {
    // Local DB unavailable — likely pre-init; the scan re-runs once initDatabase completes.
  }

  return candidates;
}
