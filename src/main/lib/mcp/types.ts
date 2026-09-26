/**
 * Type definitions for Frink MCP Proxy Architecture
 *
 * Frink acts as a meta-MCP server that proxies to underlying MCPs,
 * enabling unified config across all AI providers.
 */

/**
 * MCP server type classification
 * - cloud_api: Remote service with API key/OAuth (GitHub, Slack)
 * - local_app: Connects to local app on 127.0.0.1 (Figma, Sketch)
 * - builtin: Bundled with Frink (filesystem, etc.)
 * - custom: User-defined MCP server
 */
export type McpServerType = 'cloud_api' | 'local_app' | 'builtin' | 'custom';

/**
 * Authentication type for MCP servers
 * - none: No authentication required
 * - api_key: Simple API key in environment variable
 * - oauth: OAuth 2.0 flow required
 * - bearer: Bearer token authentication
 * - env_var: Custom environment variable(s)
 */
export type McpAuthType = 'none' | 'api_key' | 'oauth' | 'bearer' | 'env_var';

/**
 * MCP server status
 */
export type McpServerStatus = 'connected' | 'disconnected' | 'error' | 'needs_auth' | 'starting';

/**
 * Provenance of an auto-imported MCP. Set by the importer when an MCP is
 * pulled in from a native config; absent on user-created MCPs.
 *
 * Used by the importer to distinguish:
 *  - undefined → user-created, never overwrite
 *  - source matches → already imported, idempotent skip
 *  - source differs → first-source-wins, skip
 */
type FrinkMcpImportProvenance = {
  source: 'claude-global' | 'cursor-global' | 'cursor-project';
  sourcePath: string;
  importedAt: string;
};

/**
 * Individual MCP server configuration (no secrets)
 */
export type FrinkMcpServerConfig = {
  /** Display name */
  name: string;
  /** Description of what this MCP does */
  description?: string;
  /** Server type classification */
  type: McpServerType;
  /** Authentication type */
  authType: McpAuthType;
  /** Command to spawn the MCP server (for stdio-based MCPs) */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** URL for HTTP/SSE-based MCPs */
  url?: string;
  /**
   * Environment variable keys shown in Configure UI.
   * Dual semantics:
   * 1) missing required auth keys
   * 2) already-configured but rotatable/editable keys
   */
  requiredEnvVars?: string[];
  /** Whether this MCP is enabled */
  enabled?: boolean;
  /** Set when this entry was auto-imported from a native config (Claude/Cursor) */
  importedFrom?: FrinkMcpImportProvenance;
  /** Marks a server Frink registered for a connected plugin, so dedup never keys on the server name.
   * Inert to the importer and tombstone machinery, unlike `importedFrom`. */
  managedBy?: 'vendor_plugin';
  /** Canonical plugin package owning this managed connector. */
  managedPluginId?: string;
  /** Immutable Frink connection bound to this managed connector. */
  managedConnectionId?: string;
  /** True only after credential binding completes; missing is invalid for managed execution. */
  managedCredentialsReady?: boolean;
  /** Changes on every credential binding so running sessions can reject stale processes. */
  managedCredentialGeneration?: string;
};

/**
 * MCP credentials stored separately (encrypted)
 */
export type FrinkMcpCredentials = {
  /** Environment variables with actual values */
  env?: Record<string, string>;
  /** OAuth tokens */
  oauth?: {
    accessToken: string;
    refreshToken?: string;
    clientId?: string;
    expiresAt?: number;
    scope?: string;
  };
  /** HTTP headers for API key / Bearer token auth */
  headers?: Record<string, string>;
};

/**
 * Project-specific MCP configuration
 */
type FrinkProjectMcpConfig = {
  /** MCPs enabled for this project (by name) */
  mcps: string[];
  /** Config overrides per MCP (no secrets) */
  overrides?: Record<string, Partial<FrinkMcpServerConfig>>;
};

/**
 * Tombstone written when an auto-imported MCP is deleted via Frink UI.
 * Prevents the importer from re-creating the entry on the next boot scan
 * (the native config is left intact by design, so without a tombstone the
 * importer would resurrect deleted imports forever).
 */
type FrinkMcpDeletedImport = {
  source: 'claude-global' | 'cursor-global' | 'cursor-project';
  sourcePath: string;
  deletedAt: string;
};

/**
 * Main Frink MCP configuration file (~/.frink/mcp/config.json)
 * Contains NO secrets - only metadata
 */
export type FrinkMcpConfig = {
  /** Config version for migrations */
  version: number;
  /** Global MCP servers available to all projects */
  servers: Record<string, FrinkMcpServerConfig>;
  /** Project-specific MCP settings (keyed by project path) */
  projects?: Record<string, FrinkProjectMcpConfig>;
  /** Tombstones for user-deleted auto-imports (keyed by MCP name) */
  deletedImports?: Record<string, FrinkMcpDeletedImport>;
};

/**
 * Credentials file (~/.frink/mcp/credentials.json)
 * Encrypted with Electron safeStorage
 */
export type FrinkMcpCredentialsFile = {
  /** Credentials per MCP server name */
  servers: Record<string, FrinkMcpCredentials>;
};

/**
 * Auto-imported project-local config ({project}/.mcp.json)
 */
export type ProjectLocalMcpConfig = {
  /** MCP servers defined in this project */
  servers: Record<
    string,
    FrinkMcpServerConfig & {
      /** Environment variables can use ${VAR} syntax for local resolution */
      env?: Record<string, string>;
    }
  >;
};

/**
 * Aggregated MCP info for UI display
 */
export type McpServerInfo = {
  /** Server name */
  name: string;
  /** Server configuration */
  config: FrinkMcpServerConfig;
  /** Runtime status */
  status: McpServerStatus;
  /** Whether credentials are configured on this machine */
  hasCredentials: boolean;
  /** Available tools */
  tools?: string[];
  /** Error message if any */
  error?: string;
};

// ============================================================================
// Constants
// ============================================================================

/** Current config version */
export const MCP_CONFIG_VERSION = 2;

/** The registry entry a vendor plugin's chat server gets; its presence is what makes the plugin connected. */
export function vendorPluginServerConfig(pluginName: string, url: string): FrinkMcpServerConfig {
  return {
    name: `${pluginName} (plugin)`,
    description: 'Vendor plugin MCP delivered to chats',
    type: 'custom',
    authType: 'oauth',
    command: '',
    url,
    enabled: true,
    managedBy: 'vendor_plugin',
  };
}
