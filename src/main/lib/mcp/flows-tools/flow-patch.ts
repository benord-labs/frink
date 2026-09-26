/**
 * Surgical flow graph patches for frink_flows_patch MCP tool.
 * RFC 7396-style deep merge for node config; sequential ops with per-op resilience.
 */

import { z } from 'zod';
import {
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  validateGraph,
} from '../../../../shared/lib/validate-flow-graph';
import {
  type FlowSettings,
  flowSettingsShapeSchema,
} from '../../../../shared/types/flow-settings-schema';
import {
  flowGraphEdgeSchema,
  flowGraphNodeSchema,
} from '../../../../shared/types/flow-graph-schema';
import { isPlainObject } from '../../../../shared/lib/case-converter/is-transformable';
import type { FlowPatchReasonCode } from '../../../../shared/types/flows/flow-change-presentation';

const MAX_PATCH_OPERATIONS = 50;

/**
 * JSON Merge Patch–style merge: objects recurse; `null` removes a key from the result.
 */
export function deepMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMergePatch(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Seed `settings.defaultProjectId` from the flow's DB project so nodes inherit it at
 * runtime. The DB `project_id` is listing-only and never read by dispatch; the runtime
 * default is version-pinned in graph settings, so it must enter the graph before the
 * first version snapshot. No-op when the project is absent or settings already exist
 * (an existing graph's settings are authoritative).
 */
export function seedDefaultProject(
  graph: FlowGraph,
  projectId: string | null | undefined,
): FlowGraph {
  const pid = projectId?.trim();
  if (!pid || graph.settings !== undefined) return graph;
  return { ...graph, settings: { defaultProjectId: pid } };
}

const patchFlowEdgeSchema = flowGraphEdgeSchema.extend({
  sourceHandle: z.enum(['true', 'false']).optional(),
});

const patchOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('update_node'),
      nodeId: z.string().min(1),
      parentId: z.string().min(1).nullable().optional(),
      label: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
    })
    /** Reject blockType and other unknown keys so agents get an explicit Zod error, not silent no-op. */
    .strict(),
  z.object({
    op: z.literal('add_node'),
    node: flowGraphNodeSchema,
  }),
  z.object({
    op: z.literal('remove_node'),
    nodeId: z.string().min(1),
  }),
  z.object({
    op: z.literal('add_edge'),
    edge: patchFlowEdgeSchema,
  }),
  z.object({
    op: z.literal('remove_edge'),
    edgeId: z.string().min(1),
  }),
  z.object({
    op: z.literal('update_edge'),
    edgeId: z.string().min(1),
    label: z.string().optional(),
    sourceHandle: z.enum(['true', 'false']).optional(),
  }),
  z.object({
    op: z.literal('update_settings'),
    settings: flowSettingsShapeSchema.partial(),
  }),
]);

export const patchArgsSchema = z
  .object({
    /**
     * UUID of an existing flow to patch. Provide this OR `name` (not both).
     * When set: fetches the latest version and applies operations.
     */
    flowId: z.string().trim().min(1, 'flowId must be a non-empty string').optional(),
    /**
     * Display name for a new flow. Provide this OR `flowId` (not both).
     * When set: creates a new flow and applies operations to an empty graph.
     */
    name: z.string().min(1, 'name must be a non-empty string').optional(),
    /** Optional description for the new flow (only used when creating with `name`). */
    description: z.string().optional(),
    /** Optional project UUID for the new flow (only used when creating with `name`). */
    projectId: z.string().optional(),
    operations: z
      .array(patchOpSchema)
      .min(1, 'operations must contain at least one operation')
      .max(
        MAX_PATCH_OPERATIONS,
        `operations must contain at most ${MAX_PATCH_OPERATIONS} operations`,
      ),
  })
  .refine((data) => data.flowId !== undefined || data.name !== undefined, {
    message: 'Provide flowId (to modify an existing flow) or name (to create a new flow)',
    path: ['flowId'],
  })
  .refine((data) => !(data.flowId !== undefined && data.name !== undefined), {
    message: 'Provide either flowId or name, not both',
    path: ['name'],
  });

export type PatchOperation = z.infer<typeof patchOpSchema>;

/** A single operation that failed to apply. `code` is set only where the cause is classified. */
export type FailedOp = { index: number; error: string; code?: FlowPatchReasonCode };

/**
 * A single operation that was auto-skipped. `code` decides retryability: a
 * `dependency-failed` skip can succeed on retry, a `cascade-removed` one is already satisfied.
 */
export type SkippedOp = { index: number; reason: string; code: FlowPatchReasonCode };

/**
 * Result of `applyPatchOperations`:
 * - `'success'` — all ops applied, graph valid (failed/skipped are empty)
 * - `'partial'` — some ops applied, graph valid (failed/skipped are non-empty)
 * - `'failure'` — nothing saved (zero applied, or graph invalid after apply)
 */
export type PatchResult =
  | {
      status: 'success';
      graph: FlowGraph;
      applied: number[];
      failed: FailedOp[];
      skipped: SkippedOp[];
    }
  | {
      status: 'partial';
      graph: FlowGraph;
      applied: number[];
      failed: FailedOp[];
      skipped: SkippedOp[];
    }
  | {
      status: 'failure';
      error: string;
      applied: number[];
      failed: FailedOp[];
      skipped: SkippedOp[];
    };

/** Applies one `update_node` op in place; `config` deep-merges, `parentId: null` clears ownership. */
function applyNodeUpdate(node: FlowNode, op: Extract<PatchOperation, { op: 'update_node' }>): void {
  if (op.label !== undefined) node.label = op.label;
  if (op.position !== undefined) node.position = { ...op.position };
  if (op.parentId === null) delete node.parentId;
  else if (op.parentId !== undefined) node.parentId = op.parentId;
  if (op.config === undefined) return;
  const base = isPlainObject(node.config) ? (node.config as Record<string, unknown>) : {};
  node.config = deepMergePatch(base, op.config as Record<string, unknown>);
}

function nodeIdSet(nodes: FlowNode[]): Set<string> {
  return new Set(nodes.map((n) => n.id));
}

/**
 * Removes a node, the nodes it owns, and every edge touching them.
 *
 * Ownership is flat by design: a `parentId` must reference a Fan Out and Fan Outs cannot
 * nest, so every owned body node points directly at its container and one level is complete.
 */
function removeNodeAndOwnedChildren(
  graph: FlowGraph,
  nodeId: string,
): { nodeIds: string[]; edgeIds: string[] } {
  const removedIds = new Set([
    nodeId,
    ...graph.nodes.filter((node) => node.parentId === nodeId).map((node) => node.id),
  ]);
  const removedEdgeIds = graph.edges
    .filter((edge) => removedIds.has(edge.source) || removedIds.has(edge.target))
    .map((edge) => edge.id);
  graph.nodes = graph.nodes.filter((node) => !removedIds.has(node.id));
  graph.edges = graph.edges.filter(
    (edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target),
  );
  return { nodeIds: [...removedIds], edgeIds: removedEdgeIds };
}

type SkipContext = {
  /** Node IDs whose `add_node` failed — later ops referencing them cannot succeed. */
  failedNodeIds: Set<string>;
  /** Edge IDs removed by a successful `remove_node` → its 1-based operation index. */
  edgeRemovedByRemoveNodeOp: Map<string, number>;
  /** Node IDs removed by a successful `remove_node` (incl. owned children) → its 1-based index. */
  nodeRemovedByRemoveNodeOp: Map<string, number>;
};

type DependencySkip = { reason: string; code: FlowPatchReasonCode };

function notAdded(role: string, nodeId: string): DependencySkip {
  return {
    reason: `${role} '${nodeId}' was not added (see earlier failed op)`,
    code: 'dependency-failed',
  };
}

function alreadyRemoved(kind: string, id: string, removedAt: number): DependencySkip {
  return {
    reason: `${kind} '${id}' was already removed by remove_node at operation ${removedAt}`,
    code: 'cascade-removed',
  };
}

/**
 * Cascading pre-check: an op whose target was never added, or was already removed earlier in
 * this batch, is skipped rather than run so the reported cause names the causal operation.
 */
function dependencySkip(
  op: PatchOperation,
  ctx: SkipContext,
  nodes: FlowNode[],
): DependencySkip | undefined {
  switch (op.op) {
    /**
     * Only an applied removal makes a later removal benign: the node is gone and stays gone.
     * Absence is not durable while a failed `add_node` for the same id is still offered in
     * retryOps — re-sending that op alone would resurrect the node — and a later update is never
     * satisfied, since the caller wanted a change that can no longer happen. Both fall through
     * and fail, so they stay in retryOps and are re-sent alongside the op that caused them.
     */
    case 'remove_node': {
      if (nodes.some((node) => node.id === op.nodeId)) return undefined;
      if (ctx.failedNodeIds.has(op.nodeId)) return undefined;
      const removedAt = ctx.nodeRemovedByRemoveNodeOp.get(op.nodeId);
      return removedAt === undefined ? undefined : alreadyRemoved('node', op.nodeId, removedAt);
    }
    case 'update_node':
      return ctx.failedNodeIds.has(op.nodeId) ? notAdded('node', op.nodeId) : undefined;
    case 'add_edge':
      if (ctx.failedNodeIds.has(op.edge.source)) return notAdded('source node', op.edge.source);
      return ctx.failedNodeIds.has(op.edge.target)
        ? notAdded('target node', op.edge.target)
        : undefined;
    case 'remove_edge': {
      const removedAt = ctx.edgeRemovedByRemoveNodeOp.get(op.edgeId);
      return removedAt === undefined ? undefined : alreadyRemoved('edge', op.edgeId, removedAt);
    }
    default:
      return undefined;
  }
}

/**
 * Applies patch operations to a clone of `graph`, continuing past individual failures.
 *
 * Returns:
 * - `status: 'success'` — all ops applied, graph valid
 * - `status: 'partial'` — some ops applied, graph valid (with failed/skipped details)
 * - `status: 'failure'` — nothing saved (zero ops applied, or graph invalid after partial apply)
 *
 * Cascading outcomes: when `add_node` fails, subsequent ops referencing that node ID are
 * auto-skipped. When `remove_node` succeeds, the nodes and edges it implicitly removed are
 * mapped to its operation index, so later ops on them name the causal `remove_node`. Only a
 * later `remove_node`/`remove_edge` is then a satisfied skip; a later `update_node`,
 * `update_edge`, or `add_edge` touching them fails and stays retryable, because the change the
 * caller asked for never happened.
 */
export function applyPatchOperations(graph: FlowGraph, operations: PatchOperation[]): PatchResult {
  const next: FlowGraph = structuredClone(graph);
  const applied: number[] = [];
  const failed: FailedOp[] = [];
  const skipped: SkippedOp[] = [];

  const ctx: SkipContext = {
    failedNodeIds: new Set<string>(),
    edgeRemovedByRemoveNodeOp: new Map<string, number>(),
    nodeRemovedByRemoveNodeOp: new Map<string, number>(),
  };

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const idx = i + 1;
    const prefix = `Operation ${idx} (${op.op})`;

    const skip = dependencySkip(op, ctx, next.nodes);
    if (skip !== undefined) {
      skipped.push({ index: i, reason: `${prefix}: ${skip.reason}`, code: skip.code });
      continue;
    }

    let opError: string | undefined;
    let opCode: FlowPatchReasonCode | undefined;

    switch (op.op) {
      case 'update_node': {
        const node = next.nodes.find((n) => n.id === op.nodeId);
        if (node === undefined) {
          const removedAt = ctx.nodeRemovedByRemoveNodeOp.get(op.nodeId);
          opError = `${prefix}: node '${op.nodeId}' not found${
            removedAt === undefined ? '' : ` (removed by remove_node at operation ${removedAt})`
          }`;
        } else {
          applyNodeUpdate(node, op);
        }
        break;
      }
      case 'add_node': {
        const { node: raw } = op;
        if (next.nodes.some((n) => n.id === raw.id)) {
          opError = `${prefix}: node id '${raw.id}' already exists — use update_node to modify`;
        } else if (
          raw.parentId !== undefined &&
          next.nodes.find((n) => n.id === raw.parentId)?.blockType !== 'fan_out'
        ) {
          // Mirrors the save-mode parentId rule, so one bad op fails instead of the whole batch.
          opError = `${prefix}: parentId '${raw.parentId}' is not an existing Fan Out in this flow`;
          opCode = 'stale-parent';
        } else {
          const added: FlowNode = {
            id: raw.id,
            blockType: raw.blockType,
            ...(raw.parentId !== undefined ? { parentId: raw.parentId } : {}),
            ...(raw.label !== undefined ? { label: raw.label } : {}),
            ...(raw.config !== undefined ? { config: { ...raw.config } } : {}),
            ...(raw.position !== undefined ? { position: { ...raw.position } } : {}),
          };
          next.nodes.push(added);
          // The id lives again, so no earlier absence may skip later ops on it.
          ctx.failedNodeIds.delete(raw.id);
          ctx.nodeRemovedByRemoveNodeOp.delete(raw.id);
        }
        break;
      }
      case 'remove_node': {
        const ix = next.nodes.findIndex((n) => n.id === op.nodeId);
        if (ix === -1) {
          opError = `${prefix}: node '${op.nodeId}' not found`;
        } else {
          // Track implicit removals so later ops on them name the causal remove_node
          const removed = removeNodeAndOwnedChildren(next, op.nodeId);
          for (const edgeId of removed.edgeIds) ctx.edgeRemovedByRemoveNodeOp.set(edgeId, idx);
          for (const nodeId of removed.nodeIds) ctx.nodeRemovedByRemoveNodeOp.set(nodeId, idx);
        }
        break;
      }
      case 'add_edge': {
        const { edge: e } = op;
        if (next.edges.some((x) => x.id === e.id)) {
          opError = `${prefix}: edge id '${e.id}' already exists`;
        } else {
          const ids = nodeIdSet(next.nodes);
          const missing = !ids.has(e.source)
            ? { role: 'source', id: e.source }
            : !ids.has(e.target)
              ? { role: 'target', id: e.target }
              : undefined;
          if (missing !== undefined) {
            // Wiring to a node removed earlier in this batch is an authoring error, not a no-op.
            // It carries no reason code: the edge really was not added, so the receipt must keep
            // saying so. The causal removal is named in the agent-facing message instead.
            const removedAt = ctx.nodeRemovedByRemoveNodeOp.get(missing.id);
            opError = `${prefix}: ${missing.role} node '${missing.id}' not found${
              removedAt === undefined ? '' : ` (removed by remove_node at operation ${removedAt})`
            }`;
          } else {
            const edge: FlowEdge = {
              id: e.id,
              source: e.source,
              target: e.target,
              ...(e.sourceHandle !== undefined ? { sourceHandle: e.sourceHandle } : {}),
              ...(e.label !== undefined ? { label: e.label } : {}),
            };
            next.edges.push(edge);
            // The edge exists again, so an earlier cascade must not skip a later op on it.
            ctx.edgeRemovedByRemoveNodeOp.delete(edge.id);
          }
        }
        break;
      }
      case 'remove_edge': {
        const before = next.edges.length;
        next.edges = next.edges.filter((e) => e.id !== op.edgeId);
        if (next.edges.length === before) {
          opError = `${prefix}: edge '${op.edgeId}' not found`;
        }
        break;
      }
      case 'update_edge': {
        if (op.label === undefined && op.sourceHandle === undefined) {
          opError = `${prefix}: provide at least one of label or sourceHandle`;
        } else {
          const edge = next.edges.find((e) => e.id === op.edgeId);
          if (edge === undefined) {
            const removedAt = ctx.edgeRemovedByRemoveNodeOp.get(op.edgeId);
            opError = `${prefix}: edge '${op.edgeId}' not found${
              removedAt === undefined ? '' : ` (removed by remove_node at operation ${removedAt})`
            }`;
          } else {
            if (op.label !== undefined) {
              edge.label = op.label;
            }
            if (op.sourceHandle !== undefined) {
              edge.sourceHandle = op.sourceHandle;
            }
          }
        }
        break;
      }
      case 'update_settings': {
        const cur: Record<string, unknown> =
          next.settings !== undefined ? { ...next.settings } : {};
        const patch = { ...op.settings } as Record<string, unknown>;
        next.settings = deepMergePatch(cur, patch) as FlowSettings;
        break;
      }
    }

    if (opError !== undefined) {
      // Track failed add_node IDs so subsequent ops referencing this node can be skipped
      // A node's cascade mark survives (its absence is still real), but a failed add_edge drops
      // the edge's, so a later remove_edge stays retryable alongside the add rather than benign.
      if (op.op === 'add_node') ctx.failedNodeIds.add(op.node.id);
      if (op.op === 'add_edge') ctx.edgeRemovedByRemoveNodeOp.delete(op.edge.id);
      failed.push({ index: i, error: opError, ...(opCode !== undefined ? { code: opCode } : {}) });
    } else {
      applied.push(i);
    }
  }

  // Zero-applied guard: if nothing was applied, return failure without saving
  if (applied.length === 0) {
    const errMsg =
      failed.length > 0 ? failed.map((f) => f.error).join('; ') : 'No operations could be applied';
    return { status: 'failure', error: errMsg, applied, failed, skipped };
  }

  // Validate the (possibly partial) graph in save mode
  const validation = validateGraph(next, { mode: 'save' });
  if (!validation.valid) {
    const head = `Graph validation failed after applying ${applied.length}/${operations.length} ops: ${validation.errors.join('; ')}`;
    const withWarnings =
      validation.warnings !== undefined && validation.warnings.length > 0
        ? `${head} Warnings: ${validation.warnings.join('; ')}`
        : head;
    return { status: 'failure', error: withWarnings, applied, failed, skipped };
  }

  if (failed.length === 0 && skipped.length === 0) {
    return { status: 'success', graph: next, applied, failed, skipped };
  }

  return { status: 'partial', graph: next, applied, failed, skipped };
}
