/**
 * tRPC router — Custom flow node types.
 * Exposes local node discovery, cloud sync, credential management, and dynamic option fetching.
 */

import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import { INTEGRATION_NODES_SUBDIR } from '../../../../shared/integrations/plugin-nodes';
import type { CloudCustomNodeType } from '../../cloud/custom-node-types';
import {
  clearCredential,
  clearCredentialsForNode,
  getCredentialStatuses,
  setCredential,
} from '../../custom-nodes/credentials';
import {
  CUSTOM_NODE_NAME_PATTERN,
  CUSTOM_NODES_DIR,
  type CustomNodeManifest,
  discoverCustomNodes,
  readCustomNodeEntrypointPreview,
  removeLocalCustomNodeFolder,
} from '../../custom-nodes/discovery';
import { findCustomNodeManifest } from '../../custom-nodes/entrypoint-preview';
import { acquireCustomNodeReadLease } from '../../custom-nodes/installation-coordinator';
import {
  listPluginNodes,
  type PluginNodeManifest,
} from '../../integrations/plugin-node-derivation';
import { listPluginServerTools } from '../../integrations/plugin-node-derivation/server-tools';

/**
 * Project a local manifest into the cloud `CloudCustomNodeType` shape so the
 * renderer + MCP learn tool keep compiling against the same DTO. Cloud-only
 * fields:
 * - `id` — synthesized from `name` (single-user; no UUID needed locally).
 * - `verified` — hardcoded `true` for local manifests (UI badge only;
 *   reviewer confirmed no capability gating reads this).
 * - `createdAt`/`updatedAt` — synthesized from process start time (frozen
 *   at module-load) so repeated tRPC calls produce byte-identical results.
 *   Without freezing, every `list` invocation would yield a new ISO string
 *   per row, churning React Query cache keys across the 4+ renderer
 *   subscribers (block palette / config panel / health badge / template
 *   classifier). Manifest mtime would be more accurate but isn't trivially
 *   available; renderer only sorts/displays so a stable constant suffices.
 */
const STABLE_PROCESS_START_ISO = new Date().toISOString();
function manifestToCloudShape(m: CustomNodeManifest | PluginNodeManifest): CloudCustomNodeType {
  return {
    id: `local:${m.name}`,
    name: m.name,
    displayName: m.displayName,
    description: m.description,
    version: m.version,
    // Plugin-spawned nodes have no entrypoint — dispatch resolves their
    // catalog action instead of running a script.
    entrypoint: 'owner' in m ? '' : m.entrypoint,
    timeout: m.timeout,
    inputs: m.inputs,
    ...('owner' in m
      ? {
          pluginId: m.owner.pluginId,
          outputs: m.outputs,
          icon: m.icon ?? null,
          unsupportedFields: m.unsupportedFields,
        }
      : { outputs: m.outputs, icon: m.icon ?? null, pluginId: null }),
    nodePath: 'owner' in m ? '' : m.nodePath,
    verified: true,
    createdAt: STABLE_PROCESS_START_ISO,
    updatedAt: STABLE_PROCESS_START_ISO,
  };
}

import { runCustomNodeScript } from '../../custom-nodes/script-runner';
import { publicProcedure, publicProcedureRaw, router } from '../index';

const customNodeNameSchema = z
  .string()
  .min(1)
  .regex(CUSTOM_NODE_NAME_PATTERN, 'Invalid custom node name')
  // Only the machine folder itself is off limits: a user node squatting a plugin prefix is a single
  // leaf, and deleting it is the recovery discovery recommends.
  .refine((name) => name !== INTEGRATION_NODES_SUBDIR, 'Reserved custom node name');

function findLocalManifest(nodeName: string) {
  const { valid } = discoverCustomNodes(CUSTOM_NODES_DIR);
  const manifest = findCustomNodeManifest(valid, nodeName);
  if (!manifest) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Node "${nodeName}" not found locally`,
    });
  }
  return manifest;
}

function validateCredentialKey(nodeName: string, key: string) {
  const manifest = findLocalManifest(nodeName);
  if (!(key in manifest.credentials)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Credential key "${key}" is not declared in "${nodeName}" manifest`,
    });
  }
  return manifest;
}

export const customNodesRouter = router({
  // Schema-bearing DTOs already use camelCase metadata; their field dictionaries and JSON defaults
  // belong to the node/provider and must survive IPC verbatim, including mixed or delimited keys.
  /**
   * List custom node types — reads from local disk discovery instead of the
   * cloud cache. The DTO shape matches `CloudCustomNodeType` so the renderer +
   * MCP learn tool keep compiling unchanged. Plugin-spawned nodes are part of
   * the list: the palette's Integrations category, the node health badge, and
   * the config panel all resolve node types from here.
   */
  list: publicProcedureRaw.query((): CloudCustomNodeType[] => {
    const { valid } = discoverCustomNodes(CUSTOM_NODES_DIR);
    const pluginNodes = listPluginNodes();
    return [...valid, ...pluginNodes].map(manifestToCloudShape);
  }),

  discoverLocal: publicProcedureRaw.query(() => {
    return discoverCustomNodes();
  }),

  /** Live tools/list behind a plugin's generic call-tool node; a dead server is a typed failure, never `[]`. */
  pluginServerTools: publicProcedureRaw
    .input(z.object({ pluginId: z.string().min(1) }))
    .query(({ input }) => listPluginServerTools(input.pluginId)),

  /**
   * Discovery health for tooling and the flow editor: manifest quality warnings and parse/validation errors.
   * Optional `nodeName` scopes the payload to one folder under `~/.frink/nodes/`.
   */
  health: publicProcedureRaw
    .input(
      z
        .object({ nodeName: z.string().optional() })
        .optional()
        .superRefine((val, ctx) => {
          if (val === undefined) return;
          const n = val.nodeName;
          if (n !== undefined && n !== '' && !CUSTOM_NODE_NAME_PATTERN.test(n)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid custom node name' });
          }
        }),
    )
    .query(({ input }) => {
      const full = discoverCustomNodes(CUSTOM_NODES_DIR);
      const nodeName = input?.nodeName;

      if (nodeName === undefined || nodeName === '') {
        return {
          summary: {
            validCount: full.valid.length,
            nodesWithWarnings: full.manifestWarnings.length,
            invalidFolders: full.errors.length,
          },
          manifestWarnings: full.manifestWarnings,
          errors: full.errors,
        };
      }

      const manifestWarnings = full.manifestWarnings.filter((w) => w.name === nodeName);
      const errors = full.errors.filter((e) => e.dir === nodeName);
      const manifest = full.valid.find((m) => m.name === nodeName) ?? null;
      return {
        summary: {
          valid: manifest !== null,
          warningCount: manifestWarnings.reduce((n, w) => n + w.warnings.length, 0),
          errorCount: errors.length,
        },
        manifestWarnings,
        errors,
        manifest,
      };
    }),

  /** Bounded UTF-8 preview of the node's entrypoint file for read-only display in the editor. */
  readEntrypoint: publicProcedure
    .input(z.object({ nodeName: customNodeNameSchema }))
    .query(({ input }) => readCustomNodeEntrypointPreview(input.nodeName)),

  /**
   * Sync — no-op since the local manifest is the source of truth.
   * Kept on the surface so the renderer's "Sync now" button compiles
   * unchanged. Returns counts derived from the local discovery.
   */
  sync: publicProcedure.mutation(() => {
    const { valid, errors, manifestWarnings } = discoverCustomNodes(CUSTOM_NODES_DIR);
    log.info('[customNodes.sync] cloud sync deprecated; manifest is source of truth', {
      valid: valid.length,
      errors: errors.length,
      warnings: manifestWarnings.length,
    });
    return { success: true as const, synced: valid.length, errors: errors.length };
  }),

  delete: publicProcedure
    .input(z.object({ name: customNodeNameSchema }))
    .mutation(async ({ input }) => {
      const local = await removeLocalCustomNodeFolder(input.name);
      if (!local.ok) {
        throw new TRPCError({
          code: local.busy ? 'CONFLICT' : 'NOT_FOUND',
          message: local.busy
            ? local.error
            : `Custom node "${input.name}" not found: ${local.error}`,
        });
      }
      // Only user nodes live at the root; a plugin step's name resolves to nothing here and must not read as deleted.
      if (!local.removed) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Custom node "${input.name}" is not a user node under ${CUSTOM_NODES_DIR}`,
        });
      }
      try {
        clearCredentialsForNode(input.name);
      } catch (credErr) {
        log.warn('[customNodes.delete] failed to clear credentials', credErr);
      }
      return { success: true as const };
    }),

  /** Returns the status of all credentials declared in a node's local manifest. */
  getCredentialStatus: publicProcedure
    .input(z.object({ nodeName: z.string() }))
    .query(({ input }) => {
      const manifest = findLocalManifest(input.nodeName);
      return getCredentialStatuses(input.nodeName, manifest);
    }),

  /** Save a credential for a node. Value is the raw secret — encrypted before storage. */
  setCredential: publicProcedure
    .input(
      z.object({
        nodeName: z.string(),
        key: z.string(),
        value: z.string().min(1),
      }),
    )
    .mutation(({ input }) => {
      validateCredentialKey(input.nodeName, input.key);
      try {
        setCredential(input.nodeName, input.key, input.value);
        return { success: true };
      } catch (error) {
        log.error('[customNodes.setCredential]', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to save credential',
        });
      }
    }),

  /** Remove a saved credential for a node. */
  clearCredential: publicProcedure
    .input(z.object({ nodeName: z.string(), key: z.string() }))
    .mutation(({ input }) => {
      validateCredentialKey(input.nodeName, input.key);
      try {
        clearCredential(input.nodeName, input.key);
        return { success: true };
      } catch (error) {
        log.error('[customNodes.clearCredential]', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to clear credential',
        });
      }
    }),

  /**
   * Run a custom node script with injected credentials and return stdout.
   * Used by the config panel for dynamic options (`--list-options <field>`).
   *
   * Implemented as a **mutation** (not a query): spawning the script is side-effectful and must
   * not be treated as an idempotent read (no query caching / request deduplication). That applies
   * even when args are only `--list-options`, since the script may still touch disk or remote APIs.
   * Timeout: 10 seconds.
   */
  runNodeScript: publicProcedure
    .input(z.object({ nodeName: z.string(), args: z.array(z.string()) }))
    .mutation(async ({ input }) => {
      const releaseReadLease = await acquireCustomNodeReadLease(input.nodeName);
      if (!releaseReadLease) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Could not acquire a read lease for custom node "${input.nodeName}"`,
        });
      }
      try {
        const manifest = findLocalManifest(input.nodeName);
        return await runCustomNodeScript(manifest, input.args, { skipReadLease: true });
      } catch (error) {
        log.error('[customNodes.runNodeScript]', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Script execution failed',
        });
      } finally {
        releaseReadLease();
      }
    }),
});
