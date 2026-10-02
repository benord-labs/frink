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
 *
 * `tools/list` is cursor-paginated (MCP spec 2025-03-26 onward; page size is the
 * server's choice), so the probe follows `nextCursor` until it is absent.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { captureMainMessage } from '../../sentry/init';
import type {
  McpClientContext,
  McpFailure,
  McpRequestRunner,
  McpStdioServerSpec,
} from './transport';
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
 * Bound on `tools/list` pages per probe. Each page has its own operation budget, so this
 * caps a misbehaving server (endless fresh cursors) at roughly 20 x the operation window.
 */
export const MAX_TOOL_LIST_PAGES = 20;

/** One capture per (server, transport) per session when a listing is cut short. */
const capturedTruncations = new Set<string>();

/** Test seam: the dedup set is process-wide and would otherwise leak between cases. */
export function _resetMcpPaginationCaptureForTests(): void {
  capturedTruncations.clear();
}

function captureTruncation(context: McpClientContext, why: 'page_cap' | 'repeated_cursor'): void {
  const server = context.serverName ?? 'unknown';
  const key = `${server}:${context.kind}`;
  if (capturedTruncations.has(key)) return;
  capturedTruncations.add(key);
  captureMainMessage(
    `MCP ${context.kind} tools/list pagination stopped early (${why})`,
    'warning',
    { surface: 'mcp-tools-pagination', transport: context.kind, reason: why, server },
    ['mcp-tools-pagination', context.kind],
  );
}

/**
 * Follow `nextCursor`, one guarded request per page; a failing page fails the whole probe.
 * Only a repeated cursor or the page cap return a partial list, and that is captured once.
 */
async function listAllTools(
  client: Client,
  request: McpRequestRunner,
  context: McpClientContext,
): Promise<McpToolDescriptor[]> {
  const byName = new Map<string, McpToolDescriptor>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const pageCursor = cursor;
    const result = await request((options) =>
      client.listTools(pageCursor ? { cursor: pageCursor } : undefined, options),
    );
    for (const tool of toDescriptors(result.tools)) {
      if (!byName.has(tool.name)) byName.set(tool.name, tool);
    }
    cursor = result.nextCursor || undefined;
    if (!cursor) return [...byName.values()];
    if (seenCursors.has(cursor)) {
      captureTruncation(context, 'repeated_cursor');
      return [...byName.values()];
    }
    seenCursors.add(cursor);
  }
  captureTruncation(context, 'page_cap');
  return [...byName.values()];
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
  const context: McpClientContext = {
    kind: 'http',
    serverName,
    operationTimeoutMs: MCP_OPERATION_TIMEOUT_MS,
  };
  const outcome = await withMcpClient(
    context,
    () => createHttpTransport(serverUrl, headers),
    (client, request) => listAllTools(client, request, context),
  );
  return outcome.ok ? { ok: true, tools: outcome.value } : outcome;
}

/**
 * Fetch full tool descriptors from a stdio MCP server (spawned for this probe only).
 */
export async function fetchMcpToolDescriptorsStdio(
  config: McpStdioServerSpec,
  serverName?: string,
): Promise<McpToolListResult> {
  const context: McpClientContext = {
    kind: 'stdio',
    serverName,
    operationTimeoutMs: MCP_OPERATION_TIMEOUT_MS,
  };
  const outcome = await withMcpClient(
    context,
    () => createStdioTransport(config),
    (client, request) => listAllTools(client, request, context),
  );
  return outcome.ok ? { ok: true, tools: outcome.value } : outcome;
}

/**
 * Pure projection for callers whose contract is names-or-empty (the Settings
 * resolvers' negative cache). Failure is already captured at the transport
 * classifier; nothing is swallowed silently here.
 */
export function toolNames(result: McpToolListResult): string[] {
  return result.ok ? result.tools.map((t) => t.name) : [];
}
