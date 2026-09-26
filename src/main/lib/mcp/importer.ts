/**
 * MCP auto-importer.
 *
 * Pulls MCPs from native Claude/Cursor configs into Frink's own store
 * (`~/.frink/mcp/config.json` + `~/.frink/mcp/credentials.json`).
 * Idempotent — safe to run on every boot.
 */

import { safeStorage } from 'electron';
import log from 'electron-log';
import { invalidateClaudeMcpToolsCache } from './claude-tools-cache';
import { updateMcpConfigAtomic, updateMcpCredentialsAtomic } from './config';
import { type ImportCandidate, type ImportSource, scanNativeMcpSources } from './import-scanner';
import type {
  FrinkMcpConfig,
  FrinkMcpCredentials,
  FrinkMcpServerConfig,
  McpAuthType,
  McpServerType,
} from './types';

export type McpImportResult = {
  imported: number;
  conflicts: number;
  /**
   * Count of legacy entries (no `importedFrom`) that the boot pass stamped
   * by structurally matching a native candidate. Distinct from `imported`,
   * which counts brand-new entries written this run. Useful for telemetry
   * and explains why the dedup filter suddenly hides previously-visible
   * native rows.
   */
  backfilled: number;
};

const ENV_VAR_PATTERN = /^\$\{(\w+)\}$/;
const BEARER_HEADER_PATTERN = /^bearer\s/i;

let importerInflight: Promise<McpImportResult> | null = null;

/**
 * Module-level promise mutex: concurrent triggers (boot + the manual import
 * procedure) coalesce instead of racing the read-modify-write of
 * `~/.frink/mcp/config.json`.
 */
export async function runMcpImporter(): Promise<McpImportResult> {
  if (importerInflight) return importerInflight;
  importerInflight = doImport().finally(() => {
    importerInflight = null;
  });
  return importerInflight;
}

async function doImport(): Promise<McpImportResult> {
  const skipCredentials = !safeStorage.isEncryptionAvailable();
  if (skipCredentials) {
    log.warn(
      '[mcp-import] safeStorage unavailable — importing structural shells only, no credentials persisted',
    );
  }

  const candidates = await scanNativeMcpSources();
  if (candidates.length === 0) return { imported: 0, conflicts: 0, backfilled: 0 };

  // Single mutex-guarded read-modify-write of `~/.frink/mcp/config.json`
  // (shared with `setGlobalMcpServer` etc. via `updateMcpConfigAtomic`).
  // Credentials are written before the config write commits — see the
  // ordering note below.
  const importedNames: string[] = [];
  let conflicts = 0;
  let backfilled = 0;

  await updateMcpConfigAtomic(async (config) => {
    // Backfill provenance on legacy entries imported via the deprecated
    // "Detected MCPs" UI before this pipeline existed. Without `importedFrom`
    // they're invisible to the dedup filter and get re-detected as native
    // forever. Match by name + structural identity (command/args/url) so we
    // never stamp a user-created MCP that happens to share a name.
    backfilled = backfillImportedFrom(config, candidates);
    if (backfilled > 0) {
      log.info(`[mcp-import] backfilled importedFrom on ${backfilled} legacy entries`);
    }

    const grouped = groupByName(candidates);
    const credentialAdditions: Record<string, FrinkMcpCredentials> = {};

    for (const [name, group] of grouped) {
      if (config.deletedImports?.[name]) continue; // tombstone
      if (config.servers[name]) continue; // user-created or already-imported

      const isCollision = group.length > 1;
      const primary = group[0];
      const { config: serverConfig, credentials: serverCreds } = candidateToFrinkConfig(primary);

      config.servers[name] = serverConfig;
      if (primary.source === 'cursor-project' && primary.projectPath) {
        addProjectEnablement(config, primary.projectPath, name);
      }

      if (!skipCredentials && !isCollision) {
        if (serverCreds.env || serverCreds.headers || serverCreds.oauth) {
          credentialAdditions[name] = serverCreds;
        }
      }
      if (isCollision) conflicts++;
      importedNames.push(name);
    }

    // Credentials persisted first so a failure here (keychain locked, disk
    // full, sandbox revoked) never strands an `importedFrom`-tagged config
    // entry on disk without its credentials. `updateMcpCredentialsAtomic`
    // briefly acquires the credentials mutex (nested inside our config
    // mutex — same lock order everywhere) and re-reads fresh credentials so
    // a concurrent `setMcpCredentials` mutation isn't clobbered. If
    // credentials succeed and the config write later fails, the credentials
    // file holds entries that point to no server — harmless, and self-heals
    // next boot.
    if (!skipCredentials && Object.keys(credentialAdditions).length > 0) {
      await updateMcpCredentialsAtomic((credentials) => {
        for (const [name, creds] of Object.entries(credentialAdditions)) {
          credentials.servers[name] = creds;
        }
        return credentials;
      });
    }

    return config;
  });

  if (importedNames.length > 0) invalidateClaudeMcpToolsCache();

  return { imported: importedNames.length, conflicts, backfilled };
}

function groupByName(candidates: ImportCandidate[]): Map<string, ImportCandidate[]> {
  const out = new Map<string, ImportCandidate[]>();
  for (const c of candidates) {
    const list = out.get(c.name);
    if (list) list.push(c);
    else out.set(c.name, [c]);
  }
  return out;
}

/**
 * Source priority for backfill: prefer the most "global" match so a single
 * stamp hides all native rows for that name. Frink's dedup filter strips
 * a name from EVERY group of the matching source, so picking
 * `claude-global` > `cursor-global` > `cursor-project` minimizes orphan
 * rows when the same name appears in multiple sources.
 */
const BACKFILL_SOURCE_PRIORITY: Record<ImportSource, number> = {
  'claude-global': 0,
  'cursor-global': 1,
  'cursor-project': 2,
};

function candidateMatchesEntry(c: ImportCandidate, entry: FrinkMcpServerConfig): boolean {
  if ((c.config.command ?? '') !== (entry.command ?? '')) return false;
  if ((c.config.url ?? '') !== (entry.url ?? '')) return false;
  const candArgs = c.config.args ?? [];
  const entryArgs = entry.args ?? [];
  if (candArgs.length !== entryArgs.length) return false;
  for (let i = 0; i < candArgs.length; i++) {
    if (candArgs[i] !== entryArgs[i]) return false;
  }
  return true;
}

function backfillImportedFrom(config: FrinkMcpConfig, candidates: ImportCandidate[]): number {
  if (candidates.length === 0) return 0;
  const byName = groupByName(candidates);
  const now = new Date().toISOString();
  let backfilled = 0;

  for (const [name, entry] of Object.entries(config.servers)) {
    if (entry.importedFrom) continue;
    const matches = byName.get(name);
    if (!matches) continue;

    const structural = matches.filter((c) => candidateMatchesEntry(c, entry));
    if (structural.length === 0) continue;

    structural.sort(
      (a, b) => BACKFILL_SOURCE_PRIORITY[a.source] - BACKFILL_SOURCE_PRIORITY[b.source],
    );
    const chosen = structural[0];
    entry.importedFrom = {
      source: chosen.source,
      sourcePath: chosen.sourcePath,
      importedAt: now,
    };
    backfilled++;
  }

  return backfilled;
}

function addProjectEnablement(config: FrinkMcpConfig, projectPath: string, name: string): void {
  if (!config.projects) config.projects = {};
  const entry = config.projects[projectPath] ?? { mcps: [] };
  if (!entry.mcps.includes(name)) entry.mcps.push(name);
  config.projects[projectPath] = entry;
}

/**
 * Translate a native candidate into Frink's storage shape. Splits the
 * structural config from the resolved credentials so the caller can decide
 * which goes where (config → `~/.frink/mcp/config.json`;
 * credentials → encrypted local file only).
 */
export function candidateToFrinkConfig(c: ImportCandidate): {
  config: FrinkMcpServerConfig;
  credentials: FrinkMcpCredentials;
} {
  const isUrl = !c.config.command && Boolean(c.config.url);
  const type: McpServerType = isUrl ? 'cloud_api' : 'custom';

  const { resolvedEnv, requiredEnvVars } = resolveEnvWithPlaceholders(c.credentials.env);

  const credentials: FrinkMcpCredentials = {};
  if (resolvedEnv && Object.keys(resolvedEnv).length > 0) credentials.env = resolvedEnv;
  if (c.credentials.headers && Object.keys(c.credentials.headers).length > 0) {
    credentials.headers = { ...c.credentials.headers };
  }
  if (c.credentials.oauth) credentials.oauth = { ...c.credentials.oauth };

  const authType: McpAuthType = deriveAuthType(credentials);

  const sourceLabel = describeSource(c);
  const description = `Imported from ${sourceLabel}`;

  const config: FrinkMcpServerConfig = {
    name: c.name,
    description,
    type,
    authType,
    command: c.config.command ?? '',
    args: c.config.args ? [...c.config.args] : undefined,
    url: c.config.url,
    requiredEnvVars: requiredEnvVars.length > 0 ? requiredEnvVars : undefined,
    enabled: true,
    importedFrom: {
      source: c.source,
      sourcePath: c.sourcePath,
      importedAt: new Date().toISOString(),
    },
  };

  return { config, credentials };
}

/**
 * Resolve `${VAR}` placeholders against `process.env`. Cursor configs
 * commonly store secrets as `env: { TOKEN: "${TOKEN}" }`; importing the
 * literal placeholder would leave the MCP broken at runtime.
 *
 *  - Resolved → real value goes into credentials, key NOT in requiredEnvVars
 *  - Unresolved → key in requiredEnvVars, key omitted from credentials
 *  - Literal value → goes into credentials, key in requiredEnvVars (so the
 *    UI can surface it as rotatable)
 */
function resolveEnvWithPlaceholders(env: Record<string, string> | undefined): {
  resolvedEnv: Record<string, string> | undefined;
  requiredEnvVars: string[];
} {
  if (!env) return { resolvedEnv: undefined, requiredEnvVars: [] };
  const resolvedEnv: Record<string, string> = {};
  const requiredEnvVars: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    const match = v.match(ENV_VAR_PATTERN);
    if (match) {
      const fromProcess = process.env[match[1]];
      if (fromProcess) {
        resolvedEnv[k] = fromProcess;
      } else {
        requiredEnvVars.push(k);
      }
    } else {
      resolvedEnv[k] = v;
      requiredEnvVars.push(k);
    }
  }
  return {
    resolvedEnv: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    requiredEnvVars,
  };
}

function deriveAuthType(credentials: FrinkMcpCredentials): McpAuthType {
  if (credentials.oauth?.accessToken) return 'oauth';
  if (
    credentials.headers &&
    Object.values(credentials.headers).some((v) => BEARER_HEADER_PATTERN.test(v))
  ) {
    return 'bearer';
  }
  if (credentials.env && Object.keys(credentials.env).length > 0) return 'env_var';
  return 'none';
}

function describeSource(c: ImportCandidate): string {
  switch (c.source) {
    case 'claude-global':
      return 'Claude Code';
    case 'cursor-global':
      return 'Cursor';
    case 'cursor-project':
      return `Cursor (${c.projectPath ?? 'project'})`;
  }
}

/** Test-only helper: lets vitest reset the inflight promise between runs. */
export function _resetMcpImporterForTests(): void {
  importerInflight = null;
}
