/**
 * @deprecated Cloud client — custom node type cache.
 *
 * Local migration (Phase 2 finish-list #4) DROPPED the cloud cache. Local
 * manifest discovery (`discoverCustomNodes()` in `custom-nodes/discovery.ts`)
 * is the canonical source for the renderer + MCP learn tool +
 * `routers/custom-nodes.ts::list`. The boot-time loop in `src/main/index.ts`
 * was deleted, and so was the `syncCustomNodesToCloud()` no-op shim.
 *
 * File retained only for the `CloudCustomNodeType` DTO type export — consumed
 * by `routers/custom-nodes.ts::manifestToCloudShape` to project local
 * manifests into the renderer-facing shape.
 */

import type { ManifestOutputField } from '../../../shared/lib/output-schemas';

/** Exported: tRPC / declaration emit names return types (TS4023). */
export type CloudCustomNodeType = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  entrypoint: string;
  timeout: number;
  inputs: Record<string, unknown>;
  /** Output field declarations synced from manifest. Used by the UI and MCP for discoverability. */
  outputs?: Record<string, ManifestOutputField>;
  /** Curated Lucide icon key (optional). */
  icon?: string | null;
  /** Owning plugin for spawned nodes; null/absent for user-authored nodes. */
  pluginId?: string | null;
  /** Provider arguments the spawned form cannot render at all (integration-node-field-source). */
  unsupportedFields?: string[];
  nodePath: string;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
};
