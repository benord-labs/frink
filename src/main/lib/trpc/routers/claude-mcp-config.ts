/**
 * MCP-config discovery for the Settings UI: resolves every configured MCP group
 * (~/.claude.json global + per-project, ~/.cursor/mcp.json global + per-project)
 * to display status + tools. Split from claude.ts (size) — the router procedure
 * `claude.getAllMcpConfig` delegates here.
 *
 * The four group sections build CONCURRENTLY (see getAllMcpConfigHandler): a serial
 * group-by-group build made every slow/failed server cost its full probe window once
 * per group in sequence — the dominant term of the multi-minute MCP-list load
 * (bench: src/main/lib/trpc/routers/mcp-load-bench.test.ts).
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FRINK_DYNAMIC_CHAT_MCP_KEY } from '../../../../shared/lib/mcp-tool-name';
import { GLOBAL_MCP_PATH, type McpServerConfig, readClaudeConfig } from '../../claude-config';
import { getDatabase } from '../../db';
import { listProjects } from '../../db/repos/projects';
import {
  claudeConfigFingerprint,
  claudeMcpCacheKey,
  readClaudeToolsCache,
  writeClaudeToolsCache,
} from '../../mcp/claude-tools-cache';
import {
  fetchMcpToolDescriptors,
  fetchMcpToolDescriptorsStdio,
  toolNames,
} from '../../mcp/tools-probe';
import { ensureMcpTokensFresh } from '../../mcp-auth';
import { fetchOAuthMetadata, getMcpBaseUrl } from '../../oauth';
import { frinkUserHome } from '../../platform/frink-home';

// Cap for the per-failed-server OAuth-metadata probe in convertServers — it runs after that
// server's tool probe already spent its window, so it must never add another full fetch wait.
const OAUTH_METADATA_PROBE_TIMEOUT_MS = 3_000;

// Tracks which MCP servers responded with tools during getAllMcpConfigHandler warmup.
// Pre-wired for future session filtering (e.g. skip servers that failed probe).
// Not consumed at session start today — sessions pass all servers to the SDK directly.
const workingMcpServers = new Map<string, boolean>();

/**
 * Determine server status based on config
 * - If authType is "none" -> "connected" (no auth required)
 * - If has Authorization header -> "connected" (OAuth completed, SDK can use it)
 * - If has _oauth but no headers -> "needs-auth" (legacy config, needs re-auth to migrate)
 * - If HTTP server (has URL) with explicit authType -> "needs-auth"
 * - HTTP server without authType -> "connected" (assume public)
 * - Local stdio server -> "connected"
 */
export function getServerStatusFromConfig(serverConfig: McpServerConfig): string {
  const headers = serverConfig.headers as Record<string, string> | undefined;
  const { _oauth: oauth, authType } = serverConfig;

  // If authType is explicitly "none", no auth required
  if (authType === 'none') {
    return 'connected';
  }

  // If has Authorization header, it's ready for SDK to use
  if (headers?.Authorization) {
    return 'connected';
  }

  // If has _oauth but no headers, this is a legacy config that needs re-auth
  // (old format that SDK can't use)
  if (oauth?.accessToken && !headers?.Authorization) {
    return 'needs-auth';
  }

  // If HTTP server with explicit authType (oauth/bearer), needs auth
  if (serverConfig.url && ['oauth', 'bearer'].includes(authType ?? '')) {
    return 'needs-auth';
  }

  // HTTP server without authType - assume no auth required (public endpoint)
  // Local stdio server - also connected
  return 'connected';
}

/**
 * Stdio fields of on-disk JSON. Scalars coerce (`PORT: 3000` is common hand-written config) so
 * one number never drops the whole `env`; only a structurally malformed field degrades to absent.
 */
const stdioSpawnSpecSchema = z.object({
  command: z.string(),
  args: z.array(z.coerce.string()).optional().catch(undefined),
  env: z.record(z.string(), z.coerce.string()).optional().catch(undefined),
});

/**
 * Fetch tools for a connected MCP server with a 2-tier resolver:
 *   1. In-memory cache keyed by `${projectPath ?? __global__}:${name}` with
 *      a credential-aware fingerprint and a 5-min TTL.
 *   2. Probe (`fetchMcpToolDescriptors*`, projected to names via `toolNames`).
 *
 * Failure cases (probe returns `[]`) are deliberately NOT cached — see
 * `claude-tools-cache.ts`. Token rotation is handled by an explicit
 * invalidate call in `saveTokensToClaudeJson` (`mcp-auth.ts`).
 */
async function probeServerTools(name: string, serverConfig: McpServerConfig): Promise<string[]> {
  try {
    // HTTP transport
    if (serverConfig.url) {
      const headers = serverConfig.headers as Record<string, string> | undefined;
      return toolNames(await fetchMcpToolDescriptors(serverConfig.url, headers, name));
    }
    // Stdio transport
    const spec = stdioSpawnSpecSchema.safeParse(serverConfig);
    if (!spec.success) return [];
    return toolNames(await fetchMcpToolDescriptorsStdio(spec.data, name));
  } catch {
    return [];
  }
}

/**
 * In-flight cold probes, keyed on cache key AND fingerprint — never the key alone, or a probe
 * running under a rotated-away credential is handed back as this caller's answer.
 */
const probingTools = new Map<string, Promise<string[]>>();

async function fetchToolsForServer(
  name: string,
  projectPath: string | null,
  serverConfig: McpServerConfig,
): Promise<string[]> {
  const cacheKey = claudeMcpCacheKey(projectPath, name);
  const fingerprint = claudeConfigFingerprint(serverConfig);

  const cached = readClaudeToolsCache(cacheKey, fingerprint);
  if (cached) return cached;

  const probeKey = `${cacheKey}:${fingerprint}`;
  const inFlight = probingTools.get(probeKey);
  if (inFlight) return inFlight;

  const probe = probeServerTools(name, serverConfig)
    .then((tools) => {
      writeClaudeToolsCache(cacheKey, tools, fingerprint);
      return tools;
    })
    .finally(() => {
      probingTools.delete(probeKey);
    });
  probingTools.set(probeKey, probe);
  return probe;
}

/**
 * Detect whether a failed/empty probe is an auth problem.
 * Explicit `authType` wins with no probe — `oauth`/`bearer` need auth, `none` is
 * public. Only an HTTP server with an UNKNOWN authType is probed for OAuth
 * metadata, capped: it runs per failed server ON TOP of its already-spent probe
 * window, so an unresponsive host must not add another full fetch wait. The
 * timer aborts the fetch (not just Promise.race) so slow probes don't pile up;
 * an aborted/failed probe resolves null → the same "assume no auth" path.
 */
async function detectNeedsAuth(serverConfig: McpServerConfig): Promise<boolean> {
  const { authType, url } = serverConfig;
  if (authType === 'oauth' || authType === 'bearer') return true;
  if (authType === 'none' || !url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_METADATA_PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const metadata = await fetchOAuthMetadata(getMcpBaseUrl(url), controller.signal);
    return !!metadata?.authorization_endpoint;
  } catch {
    return false; // aborted or failed probe → assume no auth needed
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one server's display entry. Probes tools optimistically
 * (success ⇒ connected); on empty/failed probe falls back to OAuth-metadata
 * detection for `needs-auth`. Records the probe outcome in `workingMcpServers`.
 */
async function resolveServerEntry(
  name: string,
  projectPath: string | null,
  serverConfig: McpServerConfig,
) {
  let status = getServerStatusFromConfig(serverConfig);
  const headers = serverConfig.headers as Record<string, string> | undefined;

  let tools: string[] = [];
  try {
    tools = await fetchToolsForServer(name, projectPath, serverConfig);
  } catch (_error) {}

  const cacheKey = claudeMcpCacheKey(projectPath, name);
  let needsAuth = false;

  // If tool fetch returned results, server is definitely connected
  if (tools.length > 0) {
    status = 'connected';
    workingMcpServers.set(cacheKey, true);
  } else {
    workingMcpServers.set(cacheKey, false);
    needsAuth = await detectNeedsAuth(serverConfig);
    if (needsAuth && !headers?.Authorization) {
      status = 'needs-auth';
    }
  }

  return { name, status, tools, needsAuth, config: serverConfig as Record<string, unknown> };
}

/** Resolve display status + tools for every MCP server in a group, concurrently. */
async function convertServers(
  servers: Record<string, McpServerConfig> | undefined,
  projectPath: string | null,
) {
  if (!servers) return [];
  return Promise.all(
    Object.entries(servers).map(([name, serverConfig]) =>
      resolveServerEntry(name, projectPath, serverConfig),
    ),
  );
}

type McpGroupServer = {
  name: string;
  status: string;
  tools: string[];
  needsAuth: boolean;
  config: Record<string, unknown>;
};
export type McpGroup = {
  groupName: string;
  projectPath: string | null;
  mcpServers: McpGroupServer[];
};
type ImportSourceFilter = (
  servers: Record<string, McpServerConfig> | undefined,
  source: 'claude-global' | 'cursor-global' | 'cursor-project',
) => Record<string, McpServerConfig> | undefined;
type ClaudeConfigSnapshot = Awaited<ReturnType<typeof readClaudeConfig>>;

/** Global group (user-scope mcpServers in ~/.claude.json). Always present, even when empty. */
async function buildGlobalGroup(
  config: ClaudeConfigSnapshot,
  filter: ImportSourceFilter,
): Promise<McpGroup> {
  // Ensure tokens are fresh before fetching tools
  const globalMcpServersRaw = config.mcpServers
    ? await ensureMcpTokensFresh(config.mcpServers, GLOBAL_MCP_PATH)
    : undefined;
  // Type guard: ensure it's Record<string, McpServerConfig>
  const globalMcpServers: Record<string, McpServerConfig> | undefined =
    globalMcpServersRaw && typeof globalMcpServersRaw === 'object' && globalMcpServersRaw !== null
      ? (globalMcpServersRaw as Record<string, McpServerConfig>)
      : undefined;
  return {
    groupName: 'Global',
    projectPath: null,
    mcpServers: await convertServers(filter(globalMcpServers, 'claude-global'), null),
  };
}

/** Local-scope groups (per-project mcpServers in ~/.claude.json), in config order. */
async function buildProjectGroups(config: ClaudeConfigSnapshot): Promise<McpGroup[]> {
  const built = await Promise.all(
    Object.entries(config.projects ?? {}).map(
      async ([projectPath, projectConfig]): Promise<McpGroup | null> => {
        if (!projectConfig.mcpServers || Object.keys(projectConfig.mcpServers).length === 0) {
          return null;
        }
        const groupName = path.basename(projectPath) || projectPath;
        // Ensure tokens are fresh before fetching tools
        const freshServersRaw = await ensureMcpTokensFresh(projectConfig.mcpServers, projectPath);
        // Type guard: ensure it's Record<string, McpServerConfig>
        const freshServers: Record<string, McpServerConfig> =
          freshServersRaw && typeof freshServersRaw === 'object' && freshServersRaw !== null
            ? (freshServersRaw as Record<string, McpServerConfig>)
            : {};
        return {
          groupName,
          projectPath,
          mcpServers: await convertServers(freshServers, projectPath),
        };
      },
    ),
  );
  return built.filter((g): g is McpGroup => g !== null);
}

/** Global ~/.cursor/mcp.json group, if present. */
async function buildCursorGlobalGroup(filter: ImportSourceFilter): Promise<McpGroup | null> {
  try {
    const globalCursorMcpPath = path.join(frinkUserHome(), '.cursor', 'mcp.json');
    const content = await fs.readFile(globalCursorMcpPath, 'utf-8');
    const cursorConfig = JSON.parse(content) as { mcpServers?: Record<string, McpServerConfig> };
    if (!cursorConfig.mcpServers || Object.keys(cursorConfig.mcpServers).length === 0) return null;
    // Filter out Frink's own injected MCP, then dedup against Frink-imported entries
    const { [FRINK_DYNAMIC_CHAT_MCP_KEY]: _frinkMcp, ...otherServers } = cursorConfig.mcpServers;
    const filtered = filter(otherServers as Record<string, McpServerConfig>, 'cursor-global');
    if (!filtered || Object.keys(filtered).length === 0) return null;
    return {
      groupName: 'Cursor (Global)',
      projectPath: null,
      mcpServers: await convertServers(filtered, null),
    };
  } catch {
    // No ~/.cursor/mcp.json or invalid - skip
    return null;
  }
}

/** .cursor/mcp.json groups from registered projects, discovered in parallel. */
async function buildCursorProjectGroups(filter: ImportSourceFilter): Promise<McpGroup[]> {
  try {
    const userProjects = await listProjects(getDatabase());
    const built = await Promise.all(
      userProjects.map(async (project): Promise<McpGroup | null> => {
        try {
          const cursorMcpPath = path.join(project.path, '.cursor', 'mcp.json');
          const content = await fs.readFile(cursorMcpPath, 'utf-8');
          const cursorConfig = JSON.parse(content) as {
            mcpServers?: Record<string, McpServerConfig>;
          };
          if (!cursorConfig.mcpServers || Object.keys(cursorConfig.mcpServers).length === 0) {
            return null;
          }
          // Filter out Frink's own injected MCP, then dedup against Frink-imported entries
          const { [FRINK_DYNAMIC_CHAT_MCP_KEY]: _frinkMcp, ...otherServers } =
            cursorConfig.mcpServers;
          const filtered = filter(
            otherServers as Record<string, McpServerConfig>,
            'cursor-project',
          );
          if (!filtered || Object.keys(filtered).length === 0) return null;
          const projectName = path.basename(project.path) || project.path;
          return {
            groupName: `Cursor (${projectName})`,
            projectPath: project.path,
            mcpServers: await convertServers(filtered, project.path),
          };
        } catch {
          // No .cursor/mcp.json or invalid - skip
          return null;
        }
      }),
    );
    return built.filter((g): g is McpGroup => g !== null);
  } catch {
    // Machine/Neon not available - skip cursor MCP discovery
    return [];
  }
}

export async function getAllMcpConfigHandler(): Promise<{
  groups: McpGroup[];
  error?: string;
}> {
  try {
    workingMcpServers.clear();
    const config = await readClaudeConfig();

    // Build a name → import-source map of MCPs Frink owns via auto-import.
    // We hide each native group entry whose (name, source) matches a Frink-
    // imported entry, so the same MCP doesn't appear under both Frink Global
    // and (Claude/Cursor Global). User-created Frink MCPs (no `importedFrom`)
    // do NOT participate — both sides remain visible so the user can see the
    // collision.
    const ownedByFrink = new Map<string, string>();
    try {
      const { readMcpConfig } = await import('../../mcp/config');
      const frinkConfig = await readMcpConfig();
      for (const [n, c] of Object.entries(frinkConfig.servers)) {
        if (c.importedFrom) ownedByFrink.set(n, c.importedFrom.source);
      }
    } catch {
      // Frink MCP config unavailable — show everything (no dedup).
    }
    const filterByImportSource: ImportSourceFilter = (servers, source) => {
      if (!servers) return servers;
      const out: Record<string, McpServerConfig> = {};
      for (const [name, cfg] of Object.entries(servers)) {
        if (ownedByFrink.get(name) === source) continue;
        out[name] = cfg;
      }
      return out;
    };

    // All four sections build CONCURRENTLY — each owns its token refresh + probes and its
    // own failure isolation. Assembly order stays deterministic regardless of completion
    // order: Global, per-project (config order), Cursor (Global), Cursor (per-project).
    const [globalGroup, projectGroups, cursorGlobalGroup, cursorProjectGroups] = await Promise.all([
      buildGlobalGroup(config, filterByImportSource),
      buildProjectGroups(config),
      buildCursorGlobalGroup(filterByImportSource),
      buildCursorProjectGroups(filterByImportSource),
    ]);

    const groups: McpGroup[] = [globalGroup, ...projectGroups];
    if (cursorGlobalGroup) groups.push(cursorGlobalGroup);
    groups.push(...cursorProjectGroups);

    return { groups };
  } catch (error) {
    return { groups: [], error: String(error) };
  }
}
