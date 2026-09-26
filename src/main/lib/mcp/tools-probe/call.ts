/**
 * One-shot MCP tool invocation: connect, call ONE tool, tear down — the same
 * per-invocation lifecycle as the probes in `index.ts` (no long-lived server
 * process; a stdio child is spawned per call and reaped on close). Failures
 * stay typed: a dispatcher must distinguish a dead server (spawn/timeout)
 * from a tool-level error.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpFailure, McpStdioServerSpec } from './transport';
import {
  createHttpTransport,
  createStdioTransport,
  MCP_CALL_TIMEOUT_MS,
  withMcpClient,
} from './transport';

/** What the SDK's `callTool` resolves to (content blocks + optional structured output). */
export type McpToolCallValue = Awaited<ReturnType<Client['callTool']>>;

export type McpToolCallResult = { ok: true; result: McpToolCallValue } | McpFailure;

/**
 * Call one tool on an HTTP MCP server.
 * @param headers Optional request headers (e.g. API key / Bearer token)
 */
export async function callMcpTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
  serverName?: string,
): Promise<McpToolCallResult> {
  const outcome = await withMcpClient(
    { kind: 'http', serverName, operationTimeoutMs: MCP_CALL_TIMEOUT_MS },
    () => createHttpTransport(serverUrl, headers),
    (client, options) => client.callTool({ name: toolName, arguments: args }, undefined, options),
  );
  return outcome.ok ? { ok: true, result: outcome.value } : outcome;
}

/** Call one tool on a stdio MCP server (spawned for this invocation only). */
export async function callMcpToolStdio(
  config: McpStdioServerSpec,
  toolName: string,
  args: Record<string, unknown>,
  serverName?: string,
): Promise<McpToolCallResult> {
  const outcome = await withMcpClient(
    { kind: 'stdio', serverName, operationTimeoutMs: MCP_CALL_TIMEOUT_MS },
    () => createStdioTransport(config),
    (client, options) => client.callTool({ name: toolName, arguments: args }, undefined, options),
  );
  return outcome.ok ? { ok: true, result: outcome.value } : outcome;
}
