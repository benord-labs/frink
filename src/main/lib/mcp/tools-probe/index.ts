/**
 * MCP tool-probing: connect to a configured MCP server (HTTP or stdio) and list its tools,
 * under one shared per-probe timeout budget. Split from mcp-auth.ts (size) — auth/OAuth stays
 * there; these probes are the shared building block of the Settings MCP-status resolvers
 * (trpc/routers/mcp.ts and trpc/routers/claude-mcp-config.ts).
 *
 * Two levels:
 * - `fetchMcpToolDescriptors*`: full descriptors (`inputSchema` retained) in a result
 *   union — a dead or slow server is a typed failure, never an empty tool list.
 * - `toolNames`: pure names-or-empty projection for the Settings resolvers'
 *   negative-cache contract.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpFailure, McpStdioServerSpec } from './transport';
import {
  createHttpTransport,
  createStdioTransport,
  MCP_OPERATION_TIMEOUT_MS,
  withMcpClient,
} from './transport';

/** One tool as advertised by the server; `inputSchema` is preserved verbatim. */
export type McpToolDescriptor = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Tool['inputSchema'];
  annotations?: Tool['annotations'];
};

export type McpToolListResult = { ok: true; tools: McpToolDescriptor[] } | McpFailure;

function toDescriptors(tools: McpToolDescriptor[] | undefined): McpToolDescriptor[] {
  return (tools ?? []).map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
  }));
}

/**
 * Fetch full tool descriptors from an HTTP MCP server.
 * @param serverUrl The MCP server URL
 * @param headers Optional request headers (e.g. API key / Bearer token)
 * @param serverName Config key, for failure triage only — never a credential-bearing value
 */
export async function fetchMcpToolDescriptors(
  serverUrl: string,
  headers?: Record<string, string>,
  serverName?: string,
): Promise<McpToolListResult> {
  const outcome = await withMcpClient(
    { kind: 'http', serverName, operationTimeoutMs: MCP_OPERATION_TIMEOUT_MS },
    () => createHttpTransport(serverUrl, headers),
    (client, options) => client.listTools(undefined, options),
  );
  return outcome.ok ? { ok: true, tools: toDescriptors(outcome.value.tools) } : outcome;
}

/**
 * Fetch full tool descriptors from a stdio MCP server (spawned for this probe only).
 */
export async function fetchMcpToolDescriptorsStdio(
  config: McpStdioServerSpec,
  serverName?: string,
): Promise<McpToolListResult> {
  const outcome = await withMcpClient(
    { kind: 'stdio', serverName, operationTimeoutMs: MCP_OPERATION_TIMEOUT_MS },
    () => createStdioTransport(config),
    (client, options) => client.listTools(undefined, options),
  );
  return outcome.ok ? { ok: true, tools: toDescriptors(outcome.value.tools) } : outcome;
}

/**
 * Pure projection for callers whose contract is names-or-empty (the Settings
 * resolvers' negative cache). Failure is already captured at the transport
 * classifier; nothing is swallowed silently here.
 */
export function toolNames(result: McpToolListResult): string[] {
  return result.ok ? result.tools.map((t) => t.name) : [];
}
