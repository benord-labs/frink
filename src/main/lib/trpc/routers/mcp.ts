/* eslint-disable max-lines */
/**
 * MCP Router
 * Manages MCP server configuration and metadata sync
 *
 * Part of Phase 13 - MCP Proxy Architecture
 */

import log from 'electron-log';
import { z } from 'zod';
import {
  type FrinkMcpCredentials,
  type FrinkMcpServerConfig,
  getGlobalMcpServers,
  getMcpCredentials,
  hasMcpCredentials,
  type McpServerInfo,
  type McpServerStatus,
  normalizeMcpServerConfigForStorage,
  readMcpCredentials,
  readProjectLocalMcpConfig,
  removeGlobalMcpServer,
  removeMcpCredentials,
  setGlobalMcpServer,
  setMcpCredentials,
} from '../../mcp';
import {
  buildMcpToolFingerprint,
  hashConfigValues,
  invalidateClaudeMcpToolsCache,
  readClaudeToolsCacheEntry,
  writeClaudeToolsCache,
} from '../../mcp/claude-tools-cache';
import { probeServerTools, revalidateServerTools } from '../../mcp/tools-probe/resolve';
import { retireRetainedSessions } from '../../socket/claude-session-registry';
import { publicProcedure, router } from '../index';

// ---------------------------------------------------------------------------
// Tool probe cache — avoids re-spawning processes on every UI query. Backed by
// the shared claude-tools-cache under the `agg:` key namespace (negative caching
// + a single invalidation surface); this router owns the fingerprint.
// ---------------------------------------------------------------------------
/** Namespaced key so aggregated-info entries never collide with `getAllMcpConfig`'s. */
const aggCacheKey = (serverName: string): string => `agg:${serverName}`;

function configFingerprint(
  config: FrinkMcpServerConfig,
  credentials?: FrinkMcpCredentials | null,
): string {
  // Hash credential VALUES (not just key names): a rotated token/secret under the
  // same key can point at a different account/scope, so the fingerprint must change
  // — that self-invalidates a stale entry on the next read.
  const env = hashConfigValues(credentials?.env);
  const headers = hashConfigValues(credentials?.headers);
  const oauth = hashConfigValues(
    credentials?.oauth?.accessToken ? { t: credentials.oauth.accessToken } : undefined,
  );
  return buildMcpToolFingerprint(config, { env, oauth, headers });
}

/** Every MCP config mutation: drop cached tool lists and the idle CLIs spawned on the old config. */
function invalidateMcpToolsCache(serverName?: string): void {
  invalidateClaudeMcpToolsCache(serverName ? aggCacheKey(serverName) : undefined);
  retireRetainedSessions('mcp-config-change');
}

/**
 * Resolve a server's tool list for the aggregated UI: stale-while-revalidate over the
 * shared cache, then a cold probe. Module-scope (captures no procedure-local state).
 * Fresh or stale-but-populated entries serve instantly (stale ones refresh in the
 * background); a stale EMPTY or a fingerprint miss cold-probes, so a recovered or
 * reconfigured server is re-checked rather than shown a dead cached list.
 */
async function fetchToolsForServer(
  name: string,
  config: FrinkMcpServerConfig,
  credentials?: FrinkMcpCredentials | null,
): Promise<string[]> {
  const fp = configFingerprint(config, credentials);
  const cacheKey = aggCacheKey(name);

  const entry = readClaudeToolsCacheEntry(cacheKey, fp);
  if (entry && (!entry.stale || entry.tools.length > 0)) {
    if (entry.stale) revalidateServerTools(cacheKey, config, credentials, fp, entry.revision);
    return entry.tools;
  }

  // Cold (or stale-empty): probe now and cache (negative-cached on failure).
  const tools = await probeServerTools(config, credentials);
  writeClaudeToolsCache(cacheKey, tools, fp);
  return tools;
}

// Zod schemas for input validation
const mcpTypeSchema = z.enum(['cloud_api', 'local_app', 'builtin', 'custom']);
const authTypeSchema = z.enum(['none', 'api_key', 'oauth', 'bearer', 'env_var']);

const mcpServerConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: mcpTypeSchema,
  authType: authTypeSchema,
  command: z.string(), // Can be empty for URL-based MCPs
  args: z.array(z.string()).optional(),
  url: z.string().optional(), // For URL-based MCPs
  // Keys shown in Configure UI: missing required keys and/or rotatable keys.
  requiredEnvVars: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

const mcpCredentialsSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  oauth: z
    .object({
      accessToken: z.string(),
      refreshToken: z.string().optional(),
      clientId: z.string().optional(),
      expiresAt: z.number().optional(),
    })
    .optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpRouter = router({
  // ============================================================================
  // Local Config Operations (Frink config - ~/.frink/mcp/)
  // ============================================================================

  /**
   * List all global MCP servers from local config
   */
  listGlobalServers: publicProcedure.query(
    async (): Promise<Record<string, FrinkMcpServerConfig>> => {
      return getGlobalMcpServers();
    },
  ),

  /**
   * Add or update a global MCP server in local config
   */
  setGlobalServer: publicProcedure
    .input(z.object({ name: z.string(), config: mcpServerConfigSchema }))
    .mutation(async ({ input }): Promise<void> => {
      const normalizedConfig = normalizeMcpServerConfigForStorage(input.config);

      // Save to local config (this is the primary storage)
      await setGlobalMcpServer(input.name, normalizedConfig);
      invalidateMcpToolsCache(input.name);
    }),

  /** Remove a global MCP server from local config. */
  removeGlobalServer: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }): Promise<void> => {
      // Remove from local config
      await removeGlobalMcpServer(input.name);
      invalidateMcpToolsCache(input.name);
    }),

  /**
   * Toggle MCP server enabled/disabled state
   */
  toggleEnabled: publicProcedure
    .input(z.object({ name: z.string(), enabled: z.boolean() }))
    .mutation(async ({ input }): Promise<void> => {
      const { toggleGlobalMcpEnabled } = await import('../../mcp/config');
      await toggleGlobalMcpEnabled(input.name, input.enabled);
      invalidateMcpToolsCache(input.name);
    }),

  // ============================================================================
  // Credentials Operations (Local only - encrypted)
  // ============================================================================

  /**
   * Check if credentials exist for an MCP
   */
  hasCredentials: publicProcedure
    .input(z.object({ serverName: z.string() }))
    .query(async ({ input }): Promise<boolean> => {
      return hasMcpCredentials(input.serverName);
    }),

  /**
   * Set credentials for an MCP (local only)
   */
  setCredentials: publicProcedure
    .input(z.object({ serverName: z.string(), credentials: mcpCredentialsSchema }))
    .mutation(async ({ input }): Promise<void> => {
      await setMcpCredentials(input.serverName, input.credentials);
      invalidateMcpToolsCache(input.serverName);
    }),

  /**
   * Get credentials for an MCP (local only)
   * Note: Returns credentials - use carefully!
   */
  getCredentials: publicProcedure
    .input(z.object({ serverName: z.string() }))
    .query(async ({ input }): Promise<FrinkMcpCredentials | null> => {
      const creds = await getMcpCredentials(input.serverName);
      return creds ?? null;
    }),

  /**
   * Remove credentials for an MCP
   */
  removeCredentials: publicProcedure
    .input(z.object({ serverName: z.string() }))
    .mutation(async ({ input }): Promise<void> => {
      await removeMcpCredentials(input.serverName);
      invalidateMcpToolsCache(input.serverName);
    }),

  // ============================================================================
  // Project-Local Config (.mcp.json)
  // ============================================================================

  /**
   * Read project-local .mcp.json if it exists
   */
  readProjectLocalConfig: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(async ({ input }) => {
      return readProjectLocalMcpConfig(input.projectPath);
    }),

  // ============================================================================
  // Aggregated Views (for UI)
  // ============================================================================

  /**
   * Get comprehensive MCP info for UI display, from local config
   */
  getAggregatedMcpInfo: publicProcedure.query(async (): Promise<McpServerInfo[]> => {
    const results: McpServerInfo[] = [];

    // Always get local config - this is the source of truth
    const localServers = await getGlobalMcpServers();
    let credentialsByServer: Record<string, FrinkMcpCredentials> = {};
    try {
      const credentialsConfig = await readMcpCredentials();
      const candidateServers =
        typeof credentialsConfig === 'object' && credentialsConfig !== null
          ? (credentialsConfig as { servers?: unknown }).servers
          : undefined;
      if (
        candidateServers &&
        typeof candidateServers === 'object' &&
        !Array.isArray(candidateServers)
      ) {
        credentialsByServer = candidateServers as Record<string, FrinkMcpCredentials>;
      } else if (candidateServers !== undefined) {
        log.warn('[mcpRouter.getAggregatedMcpInfo] Ignoring malformed MCP credentials payload', {
          hasServers: true,
          serversType: Array.isArray(candidateServers) ? 'array' : typeof candidateServers,
        });
      }
    } catch (error) {
      log.warn('[mcpRouter.getAggregatedMcpInfo] Failed to read MCP credentials, continuing', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const getCredentialsForServer = (name: string): FrinkMcpCredentials | null =>
      credentialsByServer[name] ?? null;

    const hasCredentialsForServer = (name: string): boolean => {
      const creds = getCredentialsForServer(name);
      if (!creds) return false;
      return (
        !!(creds.env && Object.keys(creds.env).length > 0) ||
        !!creds.oauth?.accessToken ||
        !!(creds.headers && Object.keys(creds.headers).length > 0)
      );
    };

    // Helper to derive MCP status from auth state
    const deriveMcpStatus = (needsAuth: boolean, hasCredentials: boolean): McpServerStatus => {
      if (needsAuth) return 'needs_auth';
      if (hasCredentials) return 'connected';
      return 'disconnected';
    };

    /**
     * Helper: Build McpServerInfo from common parameters (DRY)
     */
    const buildMcpInfo = async (params: {
      name: string;
      config: FrinkMcpServerConfig;
      hasCredentials: boolean;
      isUrlBased: boolean;
      credentials: FrinkMcpCredentials | null;
      skipToolFetch?: boolean;
    }): Promise<McpServerInfo> => {
      const { name, config, hasCredentials, isUrlBased, credentials, skipToolFetch } = params;
      const needsAuth = (config.authType !== 'none' || isUrlBased) && !hasCredentials;
      const requiredEnvVars = config.requiredEnvVars || [];

      const toolsResult = skipToolFetch ? [] : await fetchToolsForServer(name, config, credentials);
      const tools = Array.isArray(toolsResult) ? toolsResult : [];
      const missingRequiredEnvVars =
        config.authType === 'env_var'
          ? requiredEnvVars.filter((envVar) => !credentials?.env?.[envVar])
          : [];
      const hasMissingRequiredEnv = missingRequiredEnvVars.length > 0;

      // Determine status:
      // - Missing required env credentials means "needs_auth" even if tools/list works.
      // - Otherwise tools/list success means "connected".
      // - Else fall back to credential heuristics.
      const mcpStatus = hasMissingRequiredEnv
        ? 'needs_auth'
        : tools && tools.length > 0
          ? 'connected'
          : deriveMcpStatus(needsAuth, hasCredentials);

      return {
        name,
        config,
        status: mcpStatus,
        hasCredentials,
        tools,
        error:
          hasMissingRequiredEnv && tools.length > 0
            ? `Tools discovered, but missing auth env vars: ${missingRequiredEnvVars.join(', ')}`
            : hasMissingRequiredEnv
              ? `Missing auth env vars: ${missingRequiredEnvVars.join(', ')}`
              : undefined,
      };
    };

    // Process local servers in parallel for better performance
    const localServerEntries = Object.entries(localServers);
    const localServerResults = await Promise.all(
      localServerEntries.map(async ([name, config]) => {
        const credentials = getCredentialsForServer(name);
        const hasCredentials = hasCredentialsForServer(name);
        return buildMcpInfo({
          name,
          config,
          hasCredentials,
          isUrlBased: !!config.url,
          credentials,
        });
      }),
    );
    results.push(...localServerResults);

    return results;
  }),

  /**
   * Re-run the native MCP importer on demand. Boot already runs it, but the
   * Refresh button calls this so users can pull in newly-added native MCPs
   * without restarting Frink. Broadcasts `mcp:imported` to every window so
   * the renderer-side `useMcpImportInvalidation` hook reconciles caches.
   */
  runImporter: publicProcedure.mutation(async () => {
    const { runMcpImporter } = await import('../../mcp/importer');
    const result = await runMcpImporter();
    if (result.imported > 0) retireRetainedSessions('mcp-config-change');
    const { BrowserWindow } = await import('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('mcp:imported', result);
    }
    return result;
  }),
});
