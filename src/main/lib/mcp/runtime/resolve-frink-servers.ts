import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { captureMainMessage } from '../../sentry/init';
import { refreshOAuthThroughSdk } from './oauth-refresh';
import { buildSafeEnv } from '../../terminal/env';
import { getGlobalMcpServers, getMcpCredentials, updateMcpCredentialsAtomic } from '../config';
import { normalizeSpawnShape } from '../spawn-shape';
import type { FrinkMcpCredentials, FrinkMcpServerConfig } from '../types';

type ResolvedFrinkMcpServer = {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Carried through so provider transports can tell frink-owned entries apart. */
  managedBy?: 'vendor_plugin';
  _oauth?: {
    accessToken: string;
    refreshToken?: string;
    clientId?: string;
    expiresAt?: number;
  };
};

type ResolvedFrinkMcpServers = Record<string, ResolvedFrinkMcpServer>;

export type ResolvedFrinkMcpRuntime = {
  servers: ResolvedFrinkMcpServers | undefined;
  envByServer: Record<string, Record<string, string>>;
};

type ResolveFrinkMcpServersOptions = {
  projectId?: string | null;
  projectPath: string;
  dynamicChatMcpUrl?: string | null;
};

type Availability = {
  available: boolean;
  reason?: string;
  resolvedEnv?: Record<string, string>;
};

type GetCredentials = (name: string) => Promise<FrinkMcpCredentials | undefined>;
type CheckAvailability = (name: string, config: FrinkMcpServerConfig) => Promise<Availability>;

const OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const oauthRefreshes = new Map<string, Promise<FrinkMcpCredentials | undefined>>();
type OAuthCredentials = NonNullable<FrinkMcpCredentials['oauth']>;
type OAuthRefreshInput = {
  url: string;
  oauth: OAuthCredentials & { refreshToken: string; clientId: string };
};

function createCredentialsGetter(): GetCredentials {
  const cache = new Map<string, FrinkMcpCredentials | undefined>();
  return async (name) => {
    if (!cache.has(name)) {
      cache.set(name, await getMcpCredentials(name));
    }
    return cache.get(name);
  };
}

function resolveRequiredEnvVars(
  requiredEnvVars: string[] | undefined,
  credsEnv: Record<string, string> | undefined,
): { resolvedEnv: Record<string, string>; missingKeys: string[] } {
  const resolvedEnv: Record<string, string> = { ...(credsEnv || {}) };
  const missingKeys: string[] = [];

  for (const key of requiredEnvVars || []) {
    const resolvedValue = resolvedEnv[key] ?? process.env[key];
    if (resolvedValue !== undefined && resolvedValue !== null) {
      resolvedEnv[key] = resolvedValue;
    } else {
      missingKeys.push(key);
    }
  }

  return { resolvedEnv, missingKeys };
}

function createAvailabilityChecker(getCredentials: GetCredentials): CheckAvailability {
  return async (name, config) => {
    if (config.enabled === false) {
      return { available: false, reason: 'disabled' };
    }

    if (config.authType !== 'env_var') {
      return { available: true };
    }

    const credentials = await getCredentials(name);
    const { resolvedEnv, missingKeys } = resolveRequiredEnvVars(
      config.requiredEnvVars,
      credentials?.env,
    );
    if (missingKeys.length > 0) {
      log.warn(
        `[Socket Executor] MCP "${name}" has missing env var(s): ${missingKeys.join(', ')} — passing to SDK anyway`,
      );
    }
    return { available: true, resolvedEnv };
  };
}

function createHttpServer(
  config: FrinkMcpServerConfig,
  credentials: FrinkMcpCredentials | undefined,
): ResolvedFrinkMcpServer {
  return {
    type: 'http',
    url: config.url,
    ...(config.managedBy && { managedBy: config.managedBy }),
    ...(credentials?.headers && { headers: credentials.headers }),
    ...(credentials?.oauth && {
      _oauth: {
        accessToken: credentials.oauth.accessToken,
        refreshToken: credentials.oauth.refreshToken,
        clientId: credentials.oauth.clientId,
        expiresAt: credentials.oauth.expiresAt,
      },
    }),
  };
}

function hasRefreshMaterial(
  oauth: OAuthCredentials | undefined,
): oauth is OAuthCredentials & { refreshToken: string; clientId: string } {
  return !!oauth?.refreshToken && !!oauth.clientId;
}

function oauthRefreshInput(
  config: FrinkMcpServerConfig,
  credentials: FrinkMcpCredentials | undefined,
): OAuthRefreshInput | undefined {
  const oauth = credentials?.oauth;
  const needsRefresh =
    !!oauth?.accessToken &&
    !!oauth.expiresAt &&
    Date.now() >= oauth.expiresAt - OAUTH_REFRESH_WINDOW_MS;
  if (!needsRefresh || !config.url || !hasRefreshMaterial(oauth)) return undefined;
  return {
    url: config.url,
    oauth: { ...oauth, refreshToken: oauth.refreshToken, clientId: oauth.clientId },
  };
}

function refreshedCredentials(
  credentials: FrinkMcpCredentials | undefined,
  oauth: OAuthRefreshInput['oauth'],
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string },
): FrinkMcpCredentials {
  return {
    ...credentials,
    oauth: {
      accessToken: tokens.accessToken,
      scope: tokens.scope ?? oauth.scope,
      refreshToken: tokens.refreshToken ?? oauth.refreshToken,
      clientId: oauth.clientId,
      expiresAt: tokens.expiresAt,
    },
    headers: {
      ...(credentials?.headers ?? {}),
      Authorization: `Bearer ${tokens.accessToken}`,
    },
  };
}

export function hasUsableOAuth(credentials: FrinkMcpCredentials | undefined): boolean {
  const oauth = credentials?.oauth;
  // expiresAt === undefined means the server granted no expiry; 0 (or any
  // number) is a real epoch timestamp — a falsy check would read 0 as eternal.
  return (
    !!oauth?.accessToken &&
    (oauth.expiresAt === undefined || Date.now() < oauth.expiresAt - OAUTH_REFRESH_WINDOW_MS)
  );
}

/** Delivery-classifier twin: fresh OR renewable at session start (oauthRefreshInput's material); passive — polled callers must never refresh. */
export function usableOrRefreshableOAuth(credentials: FrinkMcpCredentials | undefined): boolean {
  const oauth = credentials?.oauth;
  return hasUsableOAuth(credentials) || (!!oauth?.accessToken && hasRefreshMaterial(oauth));
}

function sameOAuth(
  current: FrinkMcpCredentials | undefined,
  expected: FrinkMcpCredentials | undefined,
): boolean {
  return JSON.stringify(current?.oauth ?? null) === JSON.stringify(expected?.oauth ?? null);
}

async function storeRefreshedCredentials(
  name: string,
  expected: FrinkMcpCredentials | undefined,
  oauth: OAuthRefreshInput['oauth'],
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string },
): Promise<FrinkMcpCredentials | undefined> {
  let result: FrinkMcpCredentials | undefined;
  await updateMcpCredentialsAtomic((file) => {
    const current = file.servers[name];
    if (!sameOAuth(current, expected)) {
      result = current;
      return file;
    }
    result = refreshedCredentials(current, oauth, tokens);
    file.servers[name] = result;
    return file;
  });
  return result;
}

async function refreshNearExpiryOAuthOnce(
  name: string,
  config: FrinkMcpServerConfig,
  credentials: FrinkMcpCredentials | undefined,
): Promise<FrinkMcpCredentials | undefined> {
  const input = oauthRefreshInput(config, credentials);
  if (!input) return credentials;

  try {
    const tokens = await refreshOAuthThroughSdk(input);
    return await storeRefreshedCredentials(name, credentials, input.oauth, tokens);
  } catch (error) {
    const latest = await getMcpCredentials(name);
    if (hasUsableOAuth(latest)) return latest;
    log.warn(`[Socket Executor] MCP "${name}" OAuth refresh failed; reconnect is required`);
    captureMainMessage(`MCP OAuth refresh failed: ${String(error)}`, 'warning', {
      surface: 'mcp-oauth-refresh',
      server: name,
    });
    return credentials;
  }
}

export function refreshNearExpiryOAuth(
  name: string,
  config: FrinkMcpServerConfig,
  credentials: FrinkMcpCredentials | undefined,
): Promise<FrinkMcpCredentials | undefined> {
  // Coalesce on name AND url: a vendor-plugin reinstall can move the endpoint
  // under the same server name, and a name-only key would hand the caller a
  // token minted against the PREVIOUS url. Canonical servers have a stable
  // url, so their coalescing is unchanged.
  const key = `${name}\u0000${config.url ?? ''}`;
  const existing = oauthRefreshes.get(key);
  if (existing) return existing;
  const pending = refreshNearExpiryOAuthOnce(name, config, credentials).finally(() => {
    if (oauthRefreshes.get(key) === pending) oauthRefreshes.delete(key);
  });
  oauthRefreshes.set(key, pending);
  return pending;
}

function warnForInvalidSpawn(
  name: string,
  spawnCommand: string,
  spawnArgs: string[],
  rewrites: string[],
): void {
  if (rewrites.length > 0) {
    log.info(`[Socket Executor] MCP "${name}" spawn-shape rewrites: ${rewrites.join(', ')}`);
  }
  const pathsToCheck = [
    path.isAbsolute(spawnCommand) ? spawnCommand : null,
    spawnArgs[0] && path.isAbsolute(spawnArgs[0]) ? spawnArgs[0] : null,
  ].filter(Boolean) as string[];
  const missingPath = pathsToCheck.find((candidatePath) => !fs.existsSync(candidatePath));
  if (!missingPath) return;
  log.warn(
    `[Socket Executor] MCP "${name}" has missing path: ${missingPath} — passing to SDK anyway`,
  );
}

function nonEmptyEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  return env && Object.keys(env).length > 0 ? env : undefined;
}

function scopedStdioEnv(
  spawnCommand: string,
  availability: Availability,
  credentials: FrinkMcpCredentials | undefined,
): Record<string, string> | undefined {
  const mcpSpecificEnv = nonEmptyEnv(availability.resolvedEnv) ?? nonEmptyEnv(credentials?.env);
  const isNpx = spawnCommand === 'npx' || spawnCommand.endsWith('/npx');
  if (!isNpx || mcpSpecificEnv?.npm_config_registry) return mcpSpecificEnv;
  return { ...(mcpSpecificEnv ?? {}), npm_config_registry: 'https://registry.npmjs.org/' };
}

function createStdioServer(
  name: string,
  config: FrinkMcpServerConfig,
  credentials: FrinkMcpCredentials | undefined,
  availability: Availability,
  projectPath: string,
): { name: string; server: ResolvedFrinkMcpServer; scopedEnv?: Record<string, string> } {
  const filteredArgs = (config.args || []).filter(
    (arg) => !arg.includes('API_KEY=') && !arg.includes('TOKEN='),
  );
  const spawn = normalizeSpawnShape(config.command, filteredArgs, projectPath);
  warnForInvalidSpawn(name, spawn.command, spawn.args, spawn.rewrites);
  const scopedEnv = scopedStdioEnv(spawn.command, availability, credentials);
  const mergedEnv = scopedEnv ? { ...buildSafeEnv(process.env), ...scopedEnv } : undefined;

  return {
    name: name.startsWith('@') ? `z_${name}` : name,
    server: {
      type: 'stdio',
      command: spawn.command,
      args: spawn.args,
      ...(mergedEnv ? { env: mergedEnv as Record<string, string> } : {}),
    },
    scopedEnv,
  };
}

async function loadConfiguredServer(
  name: string,
  config: FrinkMcpServerConfig,
  projectPath: string,
  getCredentials: GetCredentials,
  isAvailable: CheckAvailability,
): Promise<
  { name: string; server: ResolvedFrinkMcpServer; scopedEnv?: Record<string, string> } | undefined
> {
  const availability = await isAvailable(name, config);
  if (!availability.available) {
    log.info(`[Socket Executor] Skipping MCP "${name}" - ${availability.reason}`);
    return undefined;
  }

  log.info(`[Socket Executor] Including MCP "${name}"`);
  const credentials = await refreshNearExpiryOAuth(name, config, await getCredentials(name));
  if (config.url) return { name, server: createHttpServer(config, credentials) };
  if (config.command) {
    return createStdioServer(name, config, credentials, availability, projectPath);
  }
  log.warn(`[Socket Executor] Skipping MCP "${name}" - no url or command configured`);
  return undefined;
}

async function loadConfiguredServers(
  frinkMcps: Record<string, FrinkMcpServerConfig>,
  projectPath: string,
  getCredentials: GetCredentials,
  isAvailable: CheckAvailability,
): Promise<{
  servers: ResolvedFrinkMcpServers;
  envByServer: Record<string, Record<string, string>>;
}> {
  // Concurrent: each OAuth refresh is a network round trip, and session start waits on all of them.
  const loaded = await Promise.all(
    Object.entries(frinkMcps).map(([name, config]) =>
      loadConfiguredServer(name, config, projectPath, getCredentials, isAvailable),
    ),
  );
  const servers: ResolvedFrinkMcpServers = {};
  const envByServer: Record<string, Record<string, string>> = {};
  for (const entry of loaded) {
    if (!entry) continue;
    servers[entry.name] = entry.server;
    if (entry.scopedEnv) envByServer[entry.name] = entry.scopedEnv;
  }
  return { servers, envByServer };
}

async function addBootstrapHttpServer(
  servers: ResolvedFrinkMcpServers,
  frinkMcps: Record<string, FrinkMcpServerConfig>,
  getCredentials: GetCredentials,
  isAvailable: CheckAvailability,
): Promise<void> {
  const hasHttpMcp = Object.values(servers).some((server) => !!server.url);
  const hasStdioMcp = Object.values(servers).some((server) => !!server.command);
  if (!hasStdioMcp || hasHttpMcp) return;

  for (const [name, config] of Object.entries(frinkMcps)) {
    if (!config.url || servers[name]) continue;
    const availability = await isAvailable(name, config);
    if (!availability.available) continue;

    log.info(
      `[Socket Executor] WORKAROUND: Adding "${name}" as bootstrap HTTP MCP for stdio MCP support`,
    );
    const credentials = await refreshNearExpiryOAuth(name, config, await getCredentials(name));
    servers[name] = createHttpServer(config, credentials);
    break;
  }
}

function orderServers(servers: ResolvedFrinkMcpServers): ResolvedFrinkMcpServers {
  const orderedServers: ResolvedFrinkMcpServers = {};
  for (const [name, config] of Object.entries(servers)) {
    if (config.url) orderedServers[name] = config;
  }
  for (const [name, config] of Object.entries(servers)) {
    if (config.command) orderedServers[name] = config;
  }
  return orderedServers;
}

/** Resolve Frink's canonical MCP configuration into provider-ready runtime entries. */
export async function resolveFrinkMcpServers({
  projectId,
  projectPath,
  dynamicChatMcpUrl,
}: ResolveFrinkMcpServersOptions): Promise<ResolvedFrinkMcpRuntime> {
  let servers: ResolvedFrinkMcpServers | undefined;
  let envByServer: Record<string, Record<string, string>> = {};
  try {
    const frinkMcps = await getGlobalMcpServers();
    log.info(`[Socket Executor] Available MCPs in config: ${Object.keys(frinkMcps).join(', ')}`);
    log.info(`[Socket Executor] Current projectId: ${projectId}`);

    const getCredentials = createCredentialsGetter();
    const isAvailable = createAvailabilityChecker(getCredentials);
    const configured = await loadConfiguredServers(
      frinkMcps,
      projectPath,
      getCredentials,
      isAvailable,
    );
    await addBootstrapHttpServer(configured.servers, frinkMcps, getCredentials, isAvailable);
    servers = orderServers(configured.servers);
    envByServer = configured.envByServer;

    log.info(
      `[Socket Executor] Final loaded MCP servers (${Object.keys(servers).length}): ${Object.keys(servers).join(', ')}`,
    );
  } catch (err) {
    log.warn('[Socket Executor] Failed to load MCP servers:', err);
  }

  if (dynamicChatMcpUrl) {
    const configuredServers = { ...(servers ?? {}) };
    delete configuredServers.frink_dynamic_chat;
    servers = {
      frink_dynamic_chat: { type: 'http', url: dynamicChatMcpUrl },
      ...configuredServers,
    };
  }

  return { servers, envByServer };
}
