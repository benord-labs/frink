/** Shared MCP protocol version used across Frink MCP clients/servers. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Resolve the negotiated initialize protocol version from client params. */
export function resolveInitializeProtocolVersion(params: unknown): string {
  if (
    params &&
    typeof params === 'object' &&
    'protocolVersion' in params &&
    typeof (params as Record<string, unknown>).protocolVersion === 'string'
  ) {
    return (params as Record<string, unknown>).protocolVersion as string;
  }
  return MCP_PROTOCOL_VERSION;
}

/** The reply owed before dispatch: 202 with no body for a notification, the JSON-RPC error for a
 * malformed request, or null when the message is a request to dispatch. */
export function earlyJsonRpcReply(message: unknown): { status: 200 | 202; body?: object } | null {
  const msg = message && typeof message === 'object' ? (message as Record<string, unknown>) : {};
  const valid = msg.jsonrpc === '2.0' && typeof msg.method === 'string' && msg.method !== '';
  if (valid && msg.id !== undefined) return null;
  if (valid && String(msg.method).startsWith('notifications/')) return { status: 202 };
  const id = msg.id ?? null;
  return {
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } },
  };
}
