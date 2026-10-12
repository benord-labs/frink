/* eslint-disable max-lines, max-lines-per-function */
import { BrowserWindow, shell } from 'electron';
import log from 'electron-log';
import {
  GLOBAL_MCP_PATH,
  getMcpServerConfig,
  type McpServerConfig,
  readClaudeConfig,
  updateClaudeConfigAtomic,
  updateMcpServerConfig,
} from './claude-config';
import { claudeMcpCacheKey, invalidateClaudeMcpToolsCache } from './mcp/claude-tools-cache';
import { getFrinkMcpServerConfigForScope, setMcpCredentials } from './mcp/config';
import { waitForCallback } from './mcp/runtime/vendor-plugin-oauth-http';
import { CraftOAuth, generateState, getMcpBaseUrl, type OAuthTokens } from './oauth';
import { retireRetainedSessions } from './socket/claude-session-registry';
import { bringToFront } from './window';

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const CALLBACK_PATH = '/callback';
const CANCELLED = 'Cancelled';

type PendingOAuth = {
  serverName: string;
  projectPath: string;
  codeVerifier: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  resolve: (result: { success: boolean; error?: string }) => void;
  /** Closes this flow's loopback listener; a no-op once it has already closed. */
  closeListener: () => void;
};

const pendingOAuthFlows = new Map<string, PendingOAuth>();
/** Listeners bound but not yet pending (discovery/registration in flight), so a cancel reaches them too. */
const startingOAuthListeners = new Map<string, () => void>();

/**
 * If Frink config has a URL for this server, persist it into ~/.claude.json so
 * token refresh and callbacks can resolve the MCP endpoint.
 */
async function tryMirrorFrinkMcpUrlToClaudeJson(
  serverName: string,
  projectPathForClaude: string,
): Promise<{ url: string; type: string } | undefined> {
  try {
    const frinkServer = await getFrinkMcpServerConfigForScope(projectPathForClaude, serverName);
    if (!frinkServer?.url) {
      return undefined;
    }
    const frinkUrl = frinkServer.url;
    const serverType = frinkUrl.endsWith('/sse') ? 'sse' : 'http';
    await updateClaudeConfigAtomic((c) =>
      updateMcpServerConfig(c, projectPathForClaude, serverName, {
        url: frinkUrl,
        type: serverType,
      }),
    );
    return { url: frinkUrl, type: serverType };
  } catch (error) {
    log.warn('[mcp-auth] Failed to mirror Frink MCP config into ~/.claude.json', {
      serverName,
      projectPath: projectPathForClaude,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Start MCP OAuth flow for a server
 * Fetches OAuth metadata from .well-known endpoint
 */
export async function startMcpOAuth(
  serverName: string,
  projectPath: string,
): Promise<{ success: boolean; error?: string }> {
  // 1. Read server config from ~/.claude.json
  const config = await readClaudeConfig();
  let serverConfig = getMcpServerConfig(config, projectPath, serverName);

  // Fallback: MCPs registered through Frink live in ~/.frink/mcp/config.json
  // and/or project .mcp.json, not necessarily ~/.claude.json. Mirror the URL into
  // ~/.claude.json so handleMcpOAuthCallback / ensureMcpTokensFresh can find it.
  if (!serverConfig?.url) {
    const mirrored = await tryMirrorFrinkMcpUrlToClaudeJson(serverName, projectPath);
    if (mirrored) {
      serverConfig = mirrored;
    }
  }

  if (!serverConfig?.url) {
    return { success: false, error: `MCP server "${serverName}" URL not configured` };
  }

  // 2. Bind the loopback before any redirect_uri exists: 127.0.0.1 on an ephemeral port, in every
  // build, so the redirect_uri registered and sent is the port actually listened on.
  const state = generateState();
  const callback = waitForCallback(0, state, {
    timeoutMs: OAUTH_TIMEOUT_MS,
    callbackPath: CALLBACK_PATH,
    cancelledMessage: CANCELLED,
  });
  startingOAuthListeners.set(state, callback.cancel);
  let port: number;
  try {
    port = await callback.port;
  } catch (error) {
    startingOAuthListeners.delete(state);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  // 3. Start OAuth flow (fetches metadata from .well-known, registers, then gets auth URL)
  let authFlowResult: Awaited<ReturnType<CraftOAuth['startAuthFlow']>>;
  try {
    const oauth = new CraftOAuth(
      {
        mcpBaseUrl: getMcpBaseUrl(serverConfig.url),
        redirectUri,
        resource: serverConfig.url,
        state,
      },
      { onStatus: () => {}, onError: () => {} },
    );
    authFlowResult = await oauth.startAuthFlow();
  } catch (error) {
    startingOAuthListeners.delete(state);
    callback.cancel();
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  // A cancel (app quit) that landed while discovery ran has already closed the listener.
  if (!startingOAuthListeners.delete(state)) return { success: false, error: CANCELLED };

  const { authUrl, codeVerifier, tokenEndpoint, clientId, clientSecret } = authFlowResult;

  // 4. Store pending flow and wait for the browser to reach the loopback
  return new Promise((resolve) => {
    pendingOAuthFlows.set(state, {
      serverName,
      projectPath,
      codeVerifier,
      tokenEndpoint,
      clientId,
      clientSecret,
      redirectUri,
      resolve,
      closeListener: callback.cancel,
    });

    callback.code.then(
      (code) => handleMcpOAuthCallback(code, state),
      // Timeout or a vendor denial; a flow already settled elsewhere is no longer pending.
      (error) => {
        const pending = pendingOAuthFlows.get(state);
        if (!pending) return;
        pendingOAuthFlows.delete(state);
        pending.resolve({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );

    shell.openExternal(authUrl);
  });
}

/**
 * Handle OAuth callback from deeplink
 */
export async function handleMcpOAuthCallback(code: string, state: string): Promise<void> {
  const pending = pendingOAuthFlows.get(state);
  if (!pending) {
    return;
  }

  pendingOAuthFlows.delete(state);
  pending.closeListener();

  try {
    // 1. Get server URL for CraftOAuth
    const config = await readClaudeConfig();
    const serverUrl = getMcpServerConfig(config, pending.projectPath, pending.serverName)?.url;

    if (!serverUrl) {
      throw new Error(`Server URL not found for ${pending.serverName}`);
    }

    // 2. Use CraftOAuth to exchange code for tokens
    const oauth = new CraftOAuth(
      {
        mcpBaseUrl: getMcpBaseUrl(serverUrl),
        redirectUri: pending.redirectUri,
        resource: serverUrl,
      },
      { onStatus: () => {}, onError: () => {} },
    );

    const tokens = await oauth.completeAuthFlow(
      code,
      pending.codeVerifier,
      pending.tokenEndpoint,
      pending.clientId,
      pending.clientSecret,
    );

    // 3. Save to ~/.claude.json
    await saveTokensToClaudeJson(pending.serverName, pending.projectPath, tokens, pending.clientId);
    retireRetainedSessions('mcp-config-change');

    // 4. Notify renderer (tools will be fetched on demand via tRPC)
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('mcp-auth-completed', {
        serverName: pending.serverName,
        projectPath: pending.projectPath,
        success: true,
      });
    });

    // 5. Focus the main window after OAuth callback
    bringToFront();

    pending.resolve({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    pending.resolve({ success: false, error: msg });
  }
}

/**
 * Check if MCP token needs refresh (within 5 minutes of expiry)
 */
function needsRefresh(expiresAt: number | undefined): boolean {
  if (!expiresAt) return false;
  const fiveMinutes = 5 * 60 * 1000;
  return Date.now() > expiresAt - fiveMinutes;
}

/**
 * Refresh MCP OAuth token for a server
 * Returns the new access token, or null if refresh fails
 */
async function refreshMcpToken(serverName: string, projectPath: string): Promise<string | null> {
  try {
    let config = await readClaudeConfig();
    let serverConfig: ReturnType<typeof getMcpServerConfig> = getMcpServerConfig(
      config,
      projectPath,
      serverName,
    );
    let resolvedProjectPath: string = projectPath;

    // Mirror Frink URL for the requested scope first (keeps project-scoped _oauth).
    if (!serverConfig?.url) {
      const mirrored = await tryMirrorFrinkMcpUrlToClaudeJson(serverName, projectPath);
      if (mirrored) {
        config = await readClaudeConfig();
        serverConfig = getMcpServerConfig(config, projectPath, serverName);
      }
    }

    // Fallback: global ~/.claude.json entry (legacy).
    if (!serverConfig?.url) {
      const globalConfig = getMcpServerConfig(config, GLOBAL_MCP_PATH, serverName);
      if (globalConfig?.url) {
        serverConfig = globalConfig;
        resolvedProjectPath = GLOBAL_MCP_PATH;
      }
    }

    // Fallback: Frink global registry only.
    if (!serverConfig?.url) {
      const mirrored = await tryMirrorFrinkMcpUrlToClaudeJson(serverName, GLOBAL_MCP_PATH);
      if (mirrored) {
        config = await readClaudeConfig();
        serverConfig = getMcpServerConfig(config, GLOBAL_MCP_PATH, serverName);
        resolvedProjectPath = GLOBAL_MCP_PATH;
      }
    }

    if (!serverConfig?.url) {
      return null;
    }

    const oauth = serverConfig._oauth as
      | {
          accessToken?: string;
          refreshToken?: string;
          clientId?: string;
          expiresAt?: number;
        }
      | undefined;

    if (!oauth?.refreshToken || !oauth?.clientId) {
      return null;
    }

    // Use CraftOAuth to refresh the token
    const craftOAuth = new CraftOAuth(
      { mcpBaseUrl: getMcpBaseUrl(serverConfig.url), resource: serverConfig.url },
      { onStatus: () => {}, onError: () => {} },
    );

    const tokens = await craftOAuth.refreshAccessToken(oauth.refreshToken, oauth.clientId);

    // Update ~/.claude.json with new tokens
    await saveTokensToClaudeJson(serverName, resolvedProjectPath, tokens, oauth.clientId);
    return tokens.accessToken;
  } catch (_error) {
    return null;
  }
}

/**
 * Ensure MCP servers have valid tokens, refreshing if needed
 * Call this before passing servers to the SDK
 * Returns the servers config with updated Authorization headers
 */
export async function ensureMcpTokensFresh(
  mcpServers: Record<string, McpServerConfig>,
  projectPath: string,
): Promise<Record<string, McpServerConfig>> {
  const updatedServers = { ...mcpServers };

  // Refresh every near-expiry server in PARALLEL: the network round-trips are independent,
  // each writes to a distinct key here, and the ~/.claude.json persistence inside
  // refreshMcpToken serialises through updateClaudeConfigAtomic's mutex. A serial loop made
  // this O(n) network waits per group and was a top contributor to the slow MCP-list load.
  await Promise.all(
    Object.entries(mcpServers).map(async ([serverName, serverConfig]) => {
      const oauth = serverConfig._oauth;

      // Skip servers without OAuth, or with a token not near expiry (within 5 min)
      if (!oauth?.accessToken) return;
      if (!needsRefresh(oauth.expiresAt)) return;

      const newToken = await refreshMcpToken(serverName, projectPath);
      if (!newToken) return;

      // Update the server config with the new token
      const existingHeaders = (serverConfig.headers as Record<string, string>) || {};
      updatedServers[serverName] = {
        ...serverConfig,
        headers: {
          ...existingHeaders,
          Authorization: `Bearer ${newToken}`,
        },
        _oauth: {
          ...oauth,
          accessToken: newToken,
        },
      };
    }),
  );

  return updatedServers;
}

async function saveTokensToClaudeJson(
  serverName: string,
  projectPath: string,
  tokens: OAuthTokens,
  clientId?: string,
): Promise<void> {
  await updateClaudeConfigAtomic((config) => {
    // Get existing server config to preserve existing headers and determine type
    const existingConfig = getMcpServerConfig(config, projectPath, serverName) || {};
    const serverUrl = existingConfig.url as string | undefined;

    // Determine transport type from URL (SDK expects explicit type for HTTP servers)
    const serverType = serverUrl?.endsWith('/sse') ? 'sse' : 'http';

    // Build headers with Authorization (preserve any existing headers)
    const existingHeaders = (existingConfig.headers as Record<string, string>) || {};
    const headers = {
      ...existingHeaders,
      Authorization: `Bearer ${tokens.accessToken}`,
    };

    return updateMcpServerConfig(config, projectPath, serverName, {
      // SDK-required fields
      type: serverType,
      headers,
      // Internal tracking (for token refresh, status checking)
      _oauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        clientId,
        expiresAt: tokens.expiresAt,
      },
    });
  });

  // Token rotation changes the `Authorization` header value but the cache
  // fingerprint only encodes header *keys* and OAuth presence (boolean), so
  // the change is invisible to the fingerprint check. Bust the entry
  // explicitly so the next `getAllMcpConfig` call probes with fresh creds.
  invalidateClaudeMcpToolsCache(claudeMcpCacheKey(projectPath, serverName));

  // Mirror into Frink's encrypted credentials store so the UI's
  // getAggregatedMcpInfo can detect that this MCP is authenticated AND so the
  // Claude Agent SDK receives the Bearer header when Frink builds
  // mcpServersForSdk from Frink creds (claude router, ~line 1503).
  // Non-fatal: ~/.claude.json remains the runtime source of truth.
  try {
    await setMcpCredentials(serverName, {
      oauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        clientId,
        expiresAt: tokens.expiresAt,
      },
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
  } catch (error) {
    log.warn('[mcp-auth] Failed to mirror OAuth tokens to Frink credentials store', {
      serverName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function cancelAllPendingOAuth(): void {
  for (const closeListener of startingOAuthListeners.values()) closeListener();
  startingOAuthListeners.clear();
  const flows = [...pendingOAuthFlows.values()];
  pendingOAuthFlows.clear();
  for (const pending of flows) {
    pending.closeListener();
    pending.resolve({ success: false, error: CANCELLED });
  }
}

/**
 * Get auth status for MCP server
 */
export async function getMcpAuthStatus(
  serverName: string,
  projectPath: string,
): Promise<{ hasTokens: boolean; isExpired?: boolean }> {
  try {
    const config = await readClaudeConfig();
    const oauth = getMcpServerConfig(config, projectPath, serverName)?._oauth;

    if (!oauth?.accessToken) return { hasTokens: false };

    const isExpired = oauth.expiresAt ? Date.now() > oauth.expiresAt : false;
    return { hasTokens: true, isExpired };
  } catch {
    return { hasTokens: false };
  }
}
