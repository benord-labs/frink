/**
 * Frink MCP configuration management
 *
 * Handles reading/writing:
 * - ~/.frink/mcp/config.json (metadata, no secrets)
 * - ~/.frink/mcp/credentials.json (encrypted with safeStorage)
 */

import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import { safeStorage } from 'electron';
import { GLOBAL_MCP_PATH, resolveProjectPathFromWorktree } from '../claude-config';
import { ensureDirExistsAsync } from '../fs-helpers';
import { preserveMcpServerMetadata } from './managed-config';

import {
  type FrinkMcpConfig,
  type FrinkMcpCredentials,
  type FrinkMcpCredentialsFile,
  type FrinkMcpServerConfig,
  MCP_CONFIG_VERSION,
  type ProjectLocalMcpConfig,
} from './types';
import { frinkUserHome } from '../platform/frink-home';

// ============================================================================
// Paths
// ============================================================================

/** Base directory for Frink MCP config */
export const FRINK_MCP_DIR = path.join(frinkUserHome(), '.frink', 'mcp');

/** Main config file (no secrets) */
export const FRINK_MCP_CONFIG_PATH = path.join(FRINK_MCP_DIR, 'config.json');

/** Credentials file (encrypted) */
export const FRINK_MCP_CREDENTIALS_PATH = path.join(FRINK_MCP_DIR, 'credentials.json');

/** Project-local MCP config filename */
export const PROJECT_MCP_CONFIG_FILENAME = '.mcp.json';

// ============================================================================
// Directory Management
// ============================================================================

/** Ensure ~/.frink/mcp/ directory exists (async) */
const ensureMcpDirExistsAsync = (): Promise<void> => ensureDirExistsAsync(FRINK_MCP_DIR);

// ============================================================================
// Config File (No Secrets)
// ============================================================================

/**
 * Read ~/.frink/mcp/config.json
 */
export async function readMcpConfig(): Promise<FrinkMcpConfig> {
  try {
    const content = await fs.readFile(FRINK_MCP_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content) as FrinkMcpConfig;

    // Handle version migrations if needed
    if (config.version !== MCP_CONFIG_VERSION) {
      return migrateConfig(config);
    }

    return config;
  } catch {
    // Fresh object per call: a shared default would let a caller mutating
    // `config.servers[name]` leak state into every later reader.
    return { version: MCP_CONFIG_VERSION, servers: {}, deletedImports: {} };
  }
}

/**
 * Read ~/.frink/mcp/config.json synchronously
 */
export function readMcpConfigSync(): FrinkMcpConfig {
  try {
    const content = readFileSync(FRINK_MCP_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content) as FrinkMcpConfig;

    if (config.version !== MCP_CONFIG_VERSION) {
      return migrateConfig(config);
    }

    return config;
  } catch {
    return { version: MCP_CONFIG_VERSION, servers: {}, deletedImports: {} };
  }
}

/**
 * Write ~/.frink/mcp/config.json
 */
async function writeMcpConfig(config: FrinkMcpConfig): Promise<void> {
  await ensureMcpDirExistsAsync();
  await fs.writeFile(FRINK_MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Shared mutex covering every read-modify-write of `~/.frink/mcp/config.json`.
 *
 * The importer (`importer.ts`) and the renderer-driven mutations
 * (`setGlobalMcpServer`, `removeGlobalMcpServer`, `toggleGlobalMcpEnabled`)
 * all touch the same file. Without serialisation, an interleaved write —
 * e.g. user adds a server in Settings → MCPs while the importer is mid-flight
 * — produces lost writes because the second writer overwrites a stale snapshot.
 *
 * Mirrors `updateClaudeConfigAtomic` in `claude-config.ts:94`.
 */
let mcpConfigMutex = new Mutex();

/**
 * Test-only: replaces the shared mutex with a fresh instance. Vitest tests
 * that exercise concurrent paths can leave the mutex queued if a previous
 * test's promise was abandoned mid-`runExclusive`. Call this in `beforeEach`
 * to guarantee a clean slate. NOT called by production code.
 */
export function _resetMcpConfigMutexForTests(): void {
  mcpConfigMutex = new Mutex();
}

/**
 * Shared mutex for `~/.frink/mcp/credentials.json`, used by every caller
 * that does a read-modify-write on the encrypted credentials file:
 * `setMcpCredentials`, `removeMcpCredentials`, the credentials-clear branch
 * of `removeGlobalMcpServer`, and the importer (via
 * `updateMcpCredentialsAtomic`). Prevents lost-write races between the
 * renderer-driven Configure dialog and the importer.
 *
 * Independent of `mcpConfigMutex`: callers may briefly hold both nested
 * (config first, then credentials) — never the reverse — so the lock order
 * is consistent across the codebase.
 */
let mcpCredentialsMutex = new Mutex();

export function _resetMcpCredentialsMutexForTests(): void {
  mcpCredentialsMutex = new Mutex();
}

/**
 * Run an updater with exclusive ownership of `~/.frink/mcp/credentials.json`.
 * Reads, hands to updater, writes the return value. All credential RMW
 * paths must go through here.
 */
export async function updateMcpCredentialsAtomic(
  updater: (
    credentials: FrinkMcpCredentialsFile,
  ) => FrinkMcpCredentialsFile | Promise<FrinkMcpCredentialsFile>,
): Promise<FrinkMcpCredentialsFile> {
  return mcpCredentialsMutex.runExclusive(async () => {
    const credentials = await readMcpCredentials();
    const updated = await updater(credentials);
    await writeMcpCredentials(updated);
    return updated;
  });
}

/**
 * Run an updater with exclusive ownership of `~/.frink/mcp/config.json`.
 * Reads the current config, hands it to the updater, and writes whatever
 * the updater returns. All callers that mutate the config MUST go through
 * here so the mutex actually prevents lost writes.
 */
export async function updateMcpConfigAtomic(
  updater: (config: FrinkMcpConfig) => FrinkMcpConfig | Promise<FrinkMcpConfig>,
): Promise<FrinkMcpConfig> {
  return mcpConfigMutex.runExclusive(async () => {
    const config = await readMcpConfig();
    const updated = await updater(config);
    await writeMcpConfig(updated);
    return updated;
  });
}

// `writeMcpConfigSync` was removed: it bypassed `mcpConfigMutex` and had
// zero callers. Any future write of `~/.frink/mcp/config.json` must go
// through `updateMcpConfigAtomic` to avoid lost-write races.

/**
 * Migrate config to current version.
 *
 * v1 → v2: introduces optional `deletedImports` registry. The field is
 * optional so a missing key is not an error, but seeding it explicitly
 * prevents downstream code from having to handle `undefined` separately
 * from `{}`.
 */
function migrateConfig(config: FrinkMcpConfig): FrinkMcpConfig {
  return {
    ...config,
    deletedImports: config.deletedImports ?? {},
    version: MCP_CONFIG_VERSION,
  };
}

/**
 * Normalize MCP server config before persistence.
 * If env keys are declared, authType should not remain "none".
 */
export function normalizeMcpServerConfigForStorage(
  config: FrinkMcpServerConfig,
): FrinkMcpServerConfig {
  if (config.authType === 'none' && (config.requiredEnvVars?.length || 0) > 0) {
    return { ...config, authType: 'env_var' };
  }

  return config;
}

// ============================================================================
// Credentials File (Encrypted)
// ============================================================================

/**
 * Encrypt credentials file content
 */
function encryptCredentials(credentials: FrinkMcpCredentialsFile): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available - cannot store MCP credentials securely');
  }
  const json = JSON.stringify(credentials);
  return safeStorage.encryptString(json).toString('base64');
}

/**
 * Decrypt credentials file content
 */
function decryptCredentials(encrypted: string): FrinkMcpCredentialsFile {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available - cannot read MCP credentials');
  }
  const buffer = Buffer.from(encrypted, 'base64');
  const json = safeStorage.decryptString(buffer);
  return JSON.parse(json) as FrinkMcpCredentialsFile;
}

/**
 * Read ~/.frink/mcp/credentials.json (encrypted).
 *
 * Distinguishes "file missing" (safe to default to empty) from "decrypt or
 * parse failure" (must NOT silently default — a transient keychain issue
 * or corrupted file would otherwise let the next write overwrite a
 * possibly-recoverable encrypted blob and destroy the user's stored
 * credentials). On a hard failure, throws so the caller aborts before
 * writing.
 */
export async function readMcpCredentials(): Promise<FrinkMcpCredentialsFile> {
  let encrypted: string;
  try {
    encrypted = await fs.readFile(FRINK_MCP_CREDENTIALS_PATH, 'utf-8');
  } catch {
    return { servers: {} };
  }
  return decryptCredentials(encrypted);
}

/**
 * Write ~/.frink/mcp/credentials.json (encrypted)
 */
async function writeMcpCredentials(credentials: FrinkMcpCredentialsFile): Promise<void> {
  await ensureMcpDirExistsAsync();
  const encrypted = encryptCredentials(credentials);
  await fs.writeFile(FRINK_MCP_CREDENTIALS_PATH, encrypted, 'utf-8');
}

// `writeMcpCredentialsSync` was removed: it bypassed `mcpCredentialsMutex`
// and had zero callers. Any future write of `~/.frink/mcp/credentials.json`
// must go through `updateMcpCredentialsAtomic`.

// ============================================================================
// Server Management
// ============================================================================

/**
 * Add or update a global MCP server.
 *
 * Clears any matching tombstone in `deletedImports` so a user who deletes
 * an auto-imported MCP and later re-creates it manually with the same name
 * isn't shadowed by stale state — and so the JSON doesn't accumulate
 * orphan tombstones as users churn imports.
 */
export async function setGlobalMcpServer(
  name: string,
  server: FrinkMcpServerConfig,
): Promise<void> {
  await updateMcpConfigAtomic((config) => {
    // Preserve `importedFrom` when the caller is a user edit that doesn't
    // know about provenance. The tRPC mutation `mcp.setGlobalServer`
    // validates input via a Zod schema that strips unknown fields, so an
    // edit of an auto-imported MCP arrives here without provenance. A full
    // replacement would wipe `importedFrom` — and a subsequent delete
    // would then NOT create a tombstone, letting the importer resurrect
    // the entry on the next boot. Explicit `importedFrom` from the caller
    // takes precedence (e.g. the importer itself supplying fresh
    // provenance), otherwise we keep whatever was already on disk.
    const existing = config.servers[name];
    config.servers[name] = preserveMcpServerMetadata(server, existing);
    if (config.deletedImports?.[name]) {
      delete config.deletedImports[name];
    }
    return config;
  });
}

/**
 * Remove a global MCP server.
 *
 * If the removed server was auto-imported (`importedFrom` set), records a
 * tombstone in `config.deletedImports[name]` so the importer's next boot
 * scan doesn't resurrect it from the still-intact native config. User-
 * created entries leave no tombstone — re-creating an MCP with the same
 * name later should not be blocked.
 */
export async function removeGlobalMcpServer(name: string): Promise<void> {
  await updateMcpConfigAtomic((config) => {
    const removed = config.servers[name];
    delete config.servers[name];
    if (removed?.importedFrom) {
      if (!config.deletedImports) config.deletedImports = {};
      config.deletedImports[name] = {
        source: removed.importedFrom.source,
        sourcePath: removed.importedFrom.sourcePath,
        deletedAt: new Date().toISOString(),
      };
    }
    return config;
  });

  // Also remove credentials (separate file with its own mutex; safe to
  // acquire AFTER releasing the config mutex — never hold credentials
  // first to avoid lock-order inversion).
  await updateMcpCredentialsAtomic((credentials) => {
    delete credentials.servers[name];
    return credentials;
  });
}

/**
 * Toggle enabled state for a global MCP server
 */
export async function toggleGlobalMcpEnabled(name: string, enabled: boolean): Promise<void> {
  await updateMcpConfigAtomic((config) => {
    if (config.servers[name]) {
      config.servers[name].enabled = enabled;
    }
    return config;
  });
}

/**
 * Get all global MCP servers
 */
export async function getGlobalMcpServers(): Promise<Record<string, FrinkMcpServerConfig>> {
  const config = await readMcpConfig();
  return config.servers;
}

/**
 * Resolve a Frink MCP server definition for OAuth / Claude config mirroring:
 * global ~/.frink/mcp/config.json, per-project enablement + overrides, and
 * project-local .mcp.json (in that order per path candidate).
 */
export async function getFrinkMcpServerConfigForScope(
  projectPath: string | null | undefined,
  serverName: string,
): Promise<FrinkMcpServerConfig | undefined> {
  const frinkConfig = await readMcpConfig();
  const globalServer = frinkConfig.servers[serverName];

  if (!projectPath || projectPath === GLOBAL_MCP_PATH) {
    return globalServer;
  }

  const resolvedPath = resolveProjectPathFromWorktree(projectPath) || projectPath;
  const pathsToCheck = [...new Set([resolvedPath, projectPath].filter((p) => p.length > 0))];

  for (const p of pathsToCheck) {
    const localConfig = await readProjectLocalMcpConfig(p);
    const localServer = localConfig?.servers[serverName];
    if (localServer) {
      return localServer;
    }

    const projectEntry = frinkConfig.projects?.[p];
    if (projectEntry?.mcps?.includes(serverName) && globalServer) {
      const overrides = projectEntry.overrides?.[serverName];
      return overrides ? { ...globalServer, ...overrides } : globalServer;
    }
  }

  return globalServer;
}

// ============================================================================
// Credentials Management
// ============================================================================

/**
 * Set credentials for an MCP server
 */
export async function setMcpCredentials(
  serverName: string,
  creds: FrinkMcpCredentials,
): Promise<void> {
  await updateMcpCredentialsAtomic((credentials) => {
    const existing = credentials.servers[serverName] || {};
    credentials.servers[serverName] = { ...existing, ...creds };
    return credentials;
  });
}

/**
 * Get credentials for an MCP server
 */
export async function getMcpCredentials(
  serverName: string,
): Promise<FrinkMcpCredentials | undefined> {
  const credentials = await readMcpCredentials();
  return credentials.servers[serverName];
}

/**
 * Check if credentials exist for an MCP server
 */
export async function hasMcpCredentials(serverName: string): Promise<boolean> {
  const credentials = await readMcpCredentials();
  const creds = credentials.servers[serverName];
  if (!creds) return false;

  // Check if there's actually some credential data
  return (
    !!(creds.env && Object.keys(creds.env).length > 0) ||
    !!creds.oauth?.accessToken ||
    !!(creds.headers && Object.keys(creds.headers).length > 0)
  );
}

/**
 * Remove credentials for an MCP server
 */
export async function removeMcpCredentials(serverName: string): Promise<void> {
  await updateMcpCredentialsAtomic((credentials) => {
    delete credentials.servers[serverName];
    return credentials;
  });
}

// ============================================================================
// Project-Local Config (.mcp.json)
// ============================================================================

/**
 * Read project-local .mcp.json if it exists
 */
export async function readProjectLocalMcpConfig(
  projectPath: string,
): Promise<ProjectLocalMcpConfig | null> {
  const configPath = path.join(projectPath, PROJECT_MCP_CONFIG_FILENAME);
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content) as ProjectLocalMcpConfig;
  } catch {
    return null;
  }
}
