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
