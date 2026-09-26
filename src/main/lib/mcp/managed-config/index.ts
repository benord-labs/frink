import type { FrinkMcpServerConfig } from '../types';

const PRESERVED_MCP_SERVER_METADATA_KEYS = [
  'importedFrom',
  'managedBy',
  'managedPluginId',
  'managedConnectionId',
  'managedCredentialsReady',
  'managedCredentialGeneration',
] as const satisfies ReadonlyArray<keyof FrinkMcpServerConfig>;

export function preserveMcpServerMetadata(
  server: FrinkMcpServerConfig,
  existing: FrinkMcpServerConfig | undefined,
): FrinkMcpServerConfig {
  if (!existing) return server;
  const merged = { ...server };
  for (const key of PRESERVED_MCP_SERVER_METADATA_KEYS) {
    if (server[key] === undefined && existing[key] !== undefined) {
      Object.assign(merged, { [key]: existing[key] });
    }
  }
  return merged;
}
