import crypto from 'node:crypto';
import stableStringify from 'fast-json-stable-stringify';
import { CODEX_TASK_STOP_GUARD_TOOL_NAME } from '../../../mcp/dynamic-chat-tool-catalog';

const BEARER_HEADER = /^Bearer\s+(.+)$/i;

type CanonicalMcpServer = {
  url?: unknown;
  command?: unknown;
  args?: unknown;
  headers?: unknown;
  _oauth?: unknown;
};

type CanonicalOAuth = { accessToken?: unknown };

export type CodexMcpBinding = {
  threadConfig: Record<string, unknown>;
  revision: string;
};

function codexServerName(name: string): string {
  return name.startsWith('z_@') ? name.slice(2) : name;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim().length > 0,
    ),
  );
}

function oauthToken(server: CanonicalMcpServer): string | undefined {
  if (typeof server._oauth !== 'object' || server._oauth === null) return undefined;
  const accessToken = (server._oauth as CanonicalOAuth).accessToken;
  return typeof accessToken === 'string' && accessToken.trim() ? accessToken.trim() : undefined;
}

function withoutAuthorization(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  );
}

function resolveBearer(
  name: string,
  headers: Record<string, string>,
  token: string | undefined,
): string | undefined {
  const authorization = headers.Authorization ?? headers.authorization;
  const headerToken = authorization?.match(BEARER_HEADER)?.[1]?.trim();
  if (token && headerToken && token !== headerToken) {
    throw new Error(`Frink MCP "${name}" has conflicting OAuth and Authorization credentials.`);
  }
  return token ?? headerToken;
}

function serializeRemote(name: string, server: CanonicalMcpServer): Record<string, unknown> {
  const config: Record<string, unknown> = { enabled: true, url: server.url };
  const headers = asStringRecord(server.headers);
  const bearer = resolveBearer(name, headers, oauthToken(server));
  const projectedHeaders = bearer ? withoutAuthorization(headers) : { ...headers };
  if (bearer) projectedHeaders.Authorization = `Bearer ${bearer}`;
  if (Object.keys(projectedHeaders).length > 0) config.http_headers = projectedHeaders;
  return config;
}

function serializeStdio(
  server: CanonicalMcpServer,
  serverEnv: Record<string, string> | undefined,
): Record<string, unknown> {
  return {
    enabled: true,
    command: server.command,
    ...(Array.isArray(server.args) ? { args: server.args } : {}),
    ...(serverEnv && Object.keys(serverEnv).length > 0 ? { env: serverEnv } : {}),
  };
}

/** Replace Codex's native MCP table with Frink's project-filtered canonical set for this thread. */
export function buildCodexMcpBinding(params: {
  canonicalServers: Record<string, unknown>;
  envByServer?: Record<string, Record<string, string>>;
  taskSignalEnabled?: boolean;
}): CodexMcpBinding {
  const mcpServers: Record<string, unknown> = { __frink_replace: true };

  for (const [name, rawServer] of Object.entries(params.canonicalServers) as Array<
    [string, CanonicalMcpServer]
  >) {
    const projectedName = codexServerName(name);
    if (typeof rawServer.url === 'string') {
      mcpServers[projectedName] = serializeRemote(projectedName, rawServer);
    } else if (typeof rawServer.command === 'string') {
      mcpServers[projectedName] = serializeStdio(rawServer, params.envByServer?.[name]);
    }
  }

  const baseThreadConfig = {
    mcp_oauth_credentials_store: 'file',
    mcp_servers: mcpServers,
  };
  const threadConfig =
    params.taskSignalEnabled && mcpServers.frink_dynamic_chat
      ? {
          ...baseThreadConfig,
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'mcp_tool',
                    server: 'frink_dynamic_chat',
                    tool: CODEX_TASK_STOP_GUARD_TOOL_NAME,
                    input: { stop_hook_active: `\${stop_hook_active}` },
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        }
      : baseThreadConfig;
  const revision = crypto
    .createHash('sha256')
    .update(stableStringify(threadConfig))
    .digest('hex');
  return { threadConfig, revision };
}
