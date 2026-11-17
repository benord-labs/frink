/**
 * Custom node discovery — scans ~/.frink/nodes/ for manifest.json files.
 *
 * Exports:
 *  - discoverCustomNodes(): scan returning valid manifests (default dir TTL-cached; see invalidate)
 *  - CUSTOM_NODES_DIR: resolved path to ~/.frink/nodes/
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  CUSTOM_NODE_NAME_PATTERN,
  INTEGRATION_NODES_SUBDIR,
} from '../../../shared/integrations/plugin-nodes';
import { isKnownCustomNodeIconKey } from '../../../shared/lib/custom-node-icon-allowlist';
import type { ManifestOutputField } from '../../../shared/lib/output-schemas';
import { FRINK_CUSTOM_NODES_DIR } from '../frink-custom-nodes-dir';
import { captureMainMessage } from '../sentry/init';
import {
  type CustomNodeEntrypointPreviewResult,
  readCustomNodeEntrypointPreviewFromDisk,
} from './entrypoint-preview';
import {
  beginCustomNodeInstall,
  CUSTOM_NODE_READER_DRAIN_TIMEOUT_MS,
  isAnyCustomNodeInstallInFlight,
  waitForCustomNodeReaders,
} from './installation-coordinator';
import { classifyNodeManifest } from './plugin-manifest';
import {
  collectManifestInputWarnings,
  normalizeCustomNodeManifestFields,
  parseCustomNodeEntrypointSpec,
  resolveCustomNodeEntrypoint,
} from './runtime';

export const CUSTOM_NODES_DIR = FRINK_CUSTOM_NODES_DIR;
export { MAX_ENTRYPOINT_READ_BYTES } from './entrypoint-preview';

/** Shared with tRPC readEntrypoint — validates node folder names under ~/.frink/nodes/. */
export { CUSTOM_NODE_NAME_PATTERN };
const NAME_PATTERN = CUSTOM_NODE_NAME_PATTERN;

export type ManifestCredential = {
  required?: boolean;
  label?: string;
  /** URL to help the user obtain the credential */
  helpUrl?: string;
  /** Env var name to inject at runtime. Defaults to "{KEY_UPPER}" */
  envVar?: string;
};

export type CustomNodeManifest = {
  name: string;
  displayName: string;
  description: string;
  version: string;
  entrypoint: string;
  timeout: number;
  inputs: Record<string, unknown>;
  /** Optional credential declarations, keyed by credential name (e.g. "github") */
  credentials: Record<string, ManifestCredential>;
  /**
   * Optional output field declarations. Makes fields discoverable in the flow editor UI
   * and via the MCP learn tool. Synced to cloud; credentials are local-only.
   */
  outputs?: Record<string, ManifestOutputField>;
  /**
   * Optional Lucide icon key (curated allowlist in `custom-node-icon-allowlist.ts`).
   * Stored lowercase for lookup in the flow editor.
   */
  icon?: string;
  /** Absolute path to the node directory (e.g. ~/.frink/nodes/check-new-prs) */
  nodePath: string;
};

type ManifestValidationError = {
  dir: string;
  error: string;
};

type ManifestWarningEntry = {
  name: string;
  warnings: string[];
};

export type DiscoveryResult = {
  valid: CustomNodeManifest[];
  /** Per-node manifest quality warnings (non-fatal). */
  manifestWarnings: ManifestWarningEntry[];
  errors: ManifestValidationError[];
};

/**
 * Read a bounded UTF-8 preview of a custom node's entrypoint for the flow editor.
 * Path-safe: realpath + must stay under resolved nodes root and inside the node folder.
 */
export const readCustomNodeEntrypointPreview: (
  nodeName: string,
  nodesDir?: string,
) => CustomNodeEntrypointPreviewResult = readCustomNodeEntrypointPreviewFromDisk.bind(
  undefined,
  {
    discoverCustomNodes,
    nodeNamePattern: NAME_PATTERN,
  },
  CUSTOM_NODES_DIR,
);

/** TTL for cached discovery of the default nodes dir only (see `discoverCustomNodes`). */
const DISCOVERY_CACHE_TTL_MS = 60_000;

let discoveryCacheDefault: { result: DiscoveryResult; expiresAt: number } | null = null;
let lastCompleteDefaultDiscovery: DiscoveryResult | null = null;

/**
 * Drop cached discovery for `~/.frink/nodes` so the next `discoverCustomNodes()` rescans disk.
 * Called when the nodes directory changes (fs.watch) and before cloud sync.
 */
export function invalidateCustomNodesDiscoveryCache(nodesDir: string = CUSTOM_NODES_DIR): void {
  if (resolve(nodesDir) === CUSTOM_NODES_DIR) {
    discoveryCacheDefault = null;
  }
}

/**
 * Remove `nodesDir/{nodeName}/` (e.g. ~/.frink/nodes/my-node/) after the type is deleted from the cloud.
 * Rejects invalid names (same rules as manifest `name`) so path segments cannot escape the nodes root.
 */
export async function removeLocalCustomNodeFolder(
  nodeName: string,
  nodesDir: string = CUSTOM_NODES_DIR,
): Promise<{ ok: true; removed: boolean } | { ok: false; error: string; busy?: true }> {
  if (typeof nodeName !== 'string' || !NAME_PATTERN.test(nodeName)) {
    return { ok: false, error: 'Invalid custom node name' };
  }
  const root = resolve(nodesDir);
  const target = resolve(join(root, nodeName));
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootPrefix)) {
    return { ok: false, error: 'Refusing to delete outside nodes directory' };
  }

  const releaseInstall = beginCustomNodeInstall(nodeName);
  if (!releaseInstall) {
    return {
      ok: false,
      error: 'Another custom node change is in progress; retry after it finishes',
      busy: true,
    };
  }

  try {
    const readersDrained = await waitForCustomNodeReaders(
      nodeName,
      CUSTOM_NODE_READER_DRAIN_TIMEOUT_MS,
    );
    if (!readersDrained) {
      return {
        ok: false,
        error: `Custom node "${nodeName}" is currently running; retry after the active step finishes`,
        busy: true,
      };
    }

    if (!existsSync(target)) {
      invalidateCustomNodesDiscoveryCache(nodesDir);
      return { ok: true, removed: false };
    }
    rmSync(target, { recursive: true, force: true });
    invalidateCustomNodesDiscoveryCache(nodesDir);
    return { ok: true, removed: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Failed to remove local node folder',
    };
  } finally {
    releaseInstall();
  }
}

const VALID_OUTPUT_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);
const MAX_OUTPUTS_DEPTH = 3;

function parseOutputField(raw: unknown, depth: number): ManifestOutputField | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.type !== 'string' || !VALID_OUTPUT_TYPES.has(v.type)) return null;
  const type = v.type as ManifestOutputField['type'];
  const description = typeof v.description === 'string' ? v.description : undefined;

  let items: Record<string, ManifestOutputField> | undefined;
  if (
    type === 'array' &&
    typeof v.items === 'object' &&
    v.items !== null &&
    !Array.isArray(v.items) &&
    depth < MAX_OUTPUTS_DEPTH
  ) {
    items = parseOutputFields(v.items as Record<string, unknown>, depth + 1);
  }

  return { type, ...(description !== undefined && { description }), ...(items && { items }) };
}

function parseOutputFields(
  raw: Record<string, unknown>,
  depth: number,
): Record<string, ManifestOutputField> {
  const result: Record<string, ManifestOutputField> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = parseOutputField(value, depth);
    if (field) result[key] = field;
  }
  return result;
}

function parseOutputs(raw: unknown): Record<string, ManifestOutputField> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const fields = parseOutputFields(raw as Record<string, unknown>, 0);
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function parseCredentials(raw: unknown): Record<string, ManifestCredential> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, ManifestCredential> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    result[key] = {
      required: v.required === true,
      label: typeof v.label === 'string' ? v.label : undefined,
      helpUrl: typeof v.helpUrl === 'string' ? v.helpUrl : undefined,
      envVar: typeof v.envVar === 'string' ? v.envVar : undefined,
    };
  }
  return result;
}

function validateManifest(
  raw: unknown,
  nodePath: string,
): { ok: true; manifest: CustomNodeManifest; warnings: string[] } | { ok: false; error: string } {
  let spec: ReturnType<typeof parseCustomNodeEntrypointSpec>;
  try {
    spec = parseCustomNodeEntrypointSpec(raw);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid manifest' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !NAME_PATTERN.test(obj.name)) {
    return {
      ok: false,
      error: 'missing or invalid "name" (lowercase alphanumeric + hyphens/underscores)',
    };
  }

  const { entrypoint } = spec;

  let entrypointPath: string;
  try {
    entrypointPath = resolveCustomNodeEntrypoint(nodePath, entrypoint);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `invalid entrypoint "${entrypoint}"`,
    };
  }
  try {
    const st = statSync(entrypointPath);
    if (!st.isFile()) {
      return { ok: false, error: `entrypoint "${entrypoint}" must be a file, not a directory` };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'failed to stat entrypoint',
    };
  }

  const { hadDisplayName, ...fields } = normalizeCustomNodeManifestFields(obj.name, obj);

  const credentials = parseCredentials(obj.credentials);
  const outputs = parseOutputs(obj.outputs);

  const warnings: string[] = [];
  if (fields.description.trim() === '') {
    warnings.push('No description in manifest — add "description" for better flow editor UX');
  }
  if (!hadDisplayName) {
    warnings.push('displayName not set; using name for display');
  }
  if (outputs === undefined || Object.keys(outputs).length === 0) {
    warnings.push(
      'No outputs declared — downstream {{previous.*}} hints for other blocks will be limited',
    );
  }
  warnings.push(...collectManifestInputWarnings(fields.inputs));

  let icon: string | undefined;
  if (typeof obj.icon === 'string' && obj.icon.trim().length > 0) {
    const rawIcon = obj.icon.trim();
    icon = rawIcon.toLowerCase();
    if (!isKnownCustomNodeIconKey(icon)) {
      warnings.push(
        `Unknown icon "${rawIcon}" — use a supported icon key (see docs) or the editor falls back to Bot`,
      );
    }
  }

  return {
    ok: true,
    manifest: {
      name: obj.name,
      ...fields,
      entrypoint,
      credentials,
      ...(outputs !== undefined && { outputs }),
      ...(icon !== undefined && { icon }),
      nodePath,
    },
    warnings,
  };
}

/** Node folders one level below `dir` (hidden entries skipped); `null` when the folder cannot be read. */
function readNodeFolders(dir: string, errors: ManifestValidationError[]): string[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch (e) {
    const error = `failed to read custom nodes directory: ${e instanceof Error ? e.message : String(e)}`;
    errors.push({ dir, error });
    captureMainMessage(error, 'warning', { surface: 'custom-node-discovery' });
    return null;
  }
}

function scanNodeEntry(scanRoot: string, dirName: string, result: DiscoveryResult): void {
  const nodePath = join(scanRoot, dirName);
  const manifestPath = join(nodePath, 'manifest.json');
  if (!existsSync(manifestPath)) return;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    result.errors.push({ dir: dirName, error: `failed to parse manifest.json: ${e}` });
    return;
  }

  // Namespace squatting is an error; a leftover generated manifest (a pre-derivation flat copy) is skipped.
  const branch = classifyNodeManifest(raw, dirName);
  if (branch.branch === 'error') {
    result.errors.push({ dir: dirName, error: branch.error });
    return;
  }
  if (branch.branch === 'plugin') return;

  const scriptResult = validateManifest(raw, nodePath);
  if (scriptResult.ok) {
    result.valid.push(scriptResult.manifest);
    if (scriptResult.warnings.length > 0) {
      result.manifestWarnings.push({
        name: scriptResult.manifest.name,
        warnings: scriptResult.warnings,
      });
    }
  } else {
    result.errors.push({ dir: dirName, error: scriptResult.error });
  }
}

function discoverCustomNodesUncached(nodesDir: string): DiscoveryResult {
  const result: DiscoveryResult = { valid: [], manifestWarnings: [], errors: [] };

  if (!existsSync(nodesDir)) {
    try {
      mkdirSync(nodesDir, { recursive: true });
    } catch {
      // best-effort: if mkdir fails, just return empty
    }
    return result;
  }

  /** macOS: /var ↔ /private/var — realpath so scans match files created via /var/tmp paths. */
  let scanRoot: string;
  try {
    scanRoot = realpathSync(nodesDir);
  } catch {
    return result;
  }

  const rootEntries = readNodeFolders(scanRoot, result.errors);
  if (!rootEntries) return result;
  for (const dirName of rootEntries) {
    if (dirName === INTEGRATION_NODES_SUBDIR) {
      result.errors.push({
        dir: dirName,
        error: `plugin steps are no longer stored under ${INTEGRATION_NODES_SUBDIR}/ — delete this folder`,
      });
      continue;
    }
    scanNodeEntry(scanRoot, dirName, result);
  }
  return result;
}

/**
 * Scan `nodesDir` for custom node manifests. For the default `CUSTOM_NODES_DIR`, results are
 * cached briefly and refreshed when `invalidateCustomNodesDiscoveryCache` runs (after sync).
 * Other paths are always scanned (used by tests and non-default dirs).
 */
export function discoverCustomNodes(nodesDir: string = CUSTOM_NODES_DIR): DiscoveryResult {
  const resolved = resolve(nodesDir);
  // Use reference equality (not resolve() string compare): tmpdirs can symlink to the same
  // canonical path as ~/.frink/nodes, which would wrongly reuse the default-dir TTL cache.
  const useDefaultDirCache = nodesDir === CUSTOM_NODES_DIR;
  if (!useDefaultDirCache) {
    return discoverCustomNodesUncached(resolved);
  }

  // Registration swaps a validated temp directory through a short backup window. Synchronous
  // readers cannot wait, so keep exposing the last complete snapshot until the installer releases.
  if (isAnyCustomNodeInstallInFlight() && lastCompleteDefaultDiscovery) {
    return lastCompleteDefaultDiscovery;
  }

  const now = Date.now();
  if (discoveryCacheDefault && now < discoveryCacheDefault.expiresAt) {
    return discoveryCacheDefault.result;
  }

  const result = discoverCustomNodesUncached(resolved);
  discoveryCacheDefault = { result, expiresAt: now + DISCOVERY_CACHE_TTL_MS };
  lastCompleteDefaultDiscovery = result;
  return result;
}
