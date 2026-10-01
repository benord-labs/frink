/* eslint-disable max-lines, max-lines-per-function */
/**
 * Flow graph validation (Frink Flows): DAG shape `{ nodes, edges }`.
 */

import { getProviderById } from '../integrations/selectors';
import type { FlowBlockType, FlowSettings } from '../types/flow';
import {
  FLOW_BLOCK_TYPES,
  isCustomNodeBlockType,
  isRegisteredBlockType,
  isTriggerBlockType,
} from './block-registry';
import { canonicalStringify } from './canonical-stringify';
import { resolveFanOutStructure } from './compute-fan-out-body-chain';
import { FLOW_BLOCK_DISPLAY_LABELS } from './flow-block-display-labels';
import { findBackEdges } from './flow-graph-cycle';
import {
  AFTER_FAN_OUT_NEEDS_OUTER_START,
  AGENT_SESSION_SOURCES,
  CHAT_REPLY_SESSION_SOURCES,
  findUpstreamSession,
} from './flow-upstream-session';
import { LAUNCH_FLAGS } from '../launch-flags';
import {
  chatReplyTemplateWarnings,
  parseChatReplyTemplateConfig,
} from './flows/chat-reply-contract';
import {
  HTTP_REQUEST_MAX_BODY_UTF8_BYTES,
  HTTP_REQUEST_MAX_HEADERS_JSON_BYTES,
  HTTP_REQUEST_MAX_URL_LENGTH,
} from './http-request-limits';

const MODEL_SLUG_RE = /^[a-z0-9.-]+$/;

/** Single node in a flow graph (persisted in `flow_versions.graph`). */
export type FlowNode = {
  id: string;
  blockType: string;
  /** Fan Out owner for nodes that execute once per item. */
  parentId?: string;
  label?: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
};

/** Directed edge between nodes. */
export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  /** For branches from `condition` nodes: `"true"` or `"false"`. */
  sourceHandle?: string;
  label?: string;
};

/** Persisted flow definition: nodes + edges + optional flow-level settings. */
export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings?: FlowSettings;
};

export type GraphValidationResult =
  | { valid: true; warnings?: string[] }
  | { valid: false; errors: string[]; warnings?: string[] };

/** Max nodes per graph. Must match the cap Frink Cloud's flows route enforces. */
export const MAX_FLOW_GRAPH_NODES = 50;

/** Canvas + run-history title for a node (custom label, else registered default, else raw type). */
export function formatFlowNodeLabel(n: FlowNode): string {
  const trimmed = typeof n.label === 'string' ? n.label.trim() : '';
  if (trimmed.length > 0) return trimmed;
  return FLOW_BLOCK_DISPLAY_LABELS[n.blockType as FlowBlockType] ?? n.blockType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reachableFromTrigger(
  triggerId: string,
  nodeIds: Set<string>,
  edges: FlowEdge[],
): Set<string> {
  const seen = new Set<string>([triggerId]);
  const q = [triggerId];
  while (q.length > 0) {
    const cur = q.shift();
    if (cur === undefined) break;
    for (const e of edges) {
      if (e.source === cur && nodeIds.has(e.target) && !seen.has(e.target)) {
        seen.add(e.target);
        q.push(e.target);
      }
    }
  }
  return seen;
}

/**
 * Validation mode:
 * - `'save'` (default): topology only. Allows incomplete configs (missing instructions, no URL,
 *   etc.) so agents can build flows incrementally. Relaxes edge-count checks to warnings.
 * - `'run'`: full validation including per-block config requirements. Use before dispatching.
 */
export type ValidateGraphMode = 'save' | 'run';

/** Validates nodes, edges and topology; `mode: 'run'` also enforces block config, which `'save'`
 * leaves incomplete. Pass `webhookProvider` to warn on a trigger bound to a retired event. */
export function validateGraph(
  graph: unknown,
  options?: { mode?: ValidateGraphMode; webhookProvider?: string },
): GraphValidationResult {
  const mode = options?.mode ?? 'save';
  const isRunMode = mode === 'run';
  const errors: string[] = [];

  if (!isRecord(graph)) {
    return { valid: false, errors: ['Graph must be an object with nodes and edges'] };
  }

  const nodesRaw = graph.nodes;
  const edgesRaw = graph.edges;

  if (!Array.isArray(nodesRaw)) {
    return { valid: false, errors: ['Graph.nodes must be an array'] };
  }
  if (!Array.isArray(edgesRaw)) {
    return { valid: false, errors: ['Graph.edges must be an array'] };
  }

  const nodes = nodesRaw;
  const edges = edgesRaw as FlowEdge[];

  // Validate optional settings (warnings only — invalid values are ignored at runtime).
  if (graph.settings !== undefined) {
    if (!isRecord(graph.settings)) {
      errors.push('Graph settings must be an object when present');
    } else {
      const s = graph.settings;
      if (
        s.defaultModel !== undefined &&
        (typeof s.defaultModel !== 'string' ||
          s.defaultModel.trim().length === 0 ||
          !MODEL_SLUG_RE.test(s.defaultModel.trim()))
      ) {
        errors.push(
          'Graph settings.defaultModel must be a non-empty string matching /^[a-z0-9.-]+$/',
        );
      }
      if (
        s.defaultProjectId !== undefined &&
        (typeof s.defaultProjectId !== 'string' || s.defaultProjectId.trim().length === 0)
      ) {
        errors.push('Graph settings.defaultProjectId must be a non-empty string when present');
      }
    }
  }

  // In save mode, allow 1+ nodes (agent may add trigger first, then steps incrementally).
  // In run mode, require at least 2 nodes (trigger + at least one step).
  if (isRunMode && nodes.length < 2) {
    return {
      valid: false,
      errors: ['Graph must contain at least 2 nodes (trigger + at least one step)'],
    };
  }

  if (nodes.length > MAX_FLOW_GRAPH_NODES) {
    return {
      valid: false,
      errors: [`Graph cannot exceed ${MAX_FLOW_GRAPH_NODES} nodes`],
    };
  }

  const nodeIds = new Set<string>();
  let triggerId: string | null = null;
  let triggerCount = 0;

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const nodeIndex = i + 1;

    if (!isRecord(node)) {
      errors.push(`Node ${nodeIndex} must be an object`);
      continue;
    }

    const id = node.id;
    const blockType = node.blockType;

    if (typeof id !== 'string' || id.trim() === '') {
      errors.push(`Node ${nodeIndex} must have a non-empty string id`);
    } else if (nodeIds.has(id)) {
      errors.push(`Node ${nodeIndex} has duplicate id: ${id}`);
    } else {
      nodeIds.add(id);
    }

    if (
      typeof blockType !== 'string' ||
      (!isRegisteredBlockType(blockType) && !isCustomNodeBlockType(blockType))
    ) {
      errors.push(
        `Node ${nodeIndex} has invalid blockType "${String(blockType)}". Must be a built-in type (${FLOW_BLOCK_TYPES.join(', ')}) or a valid custom node name.`,
      );
    } else if (isTriggerBlockType(blockType)) {
      triggerCount += 1;
      if (typeof id === 'string' && id.trim() !== '') {
        triggerId = id;
      }
    }

    if (node.config != null && !isRecord(node.config)) {
      errors.push(`Node ${nodeIndex} config must be an object`);
    }
    if (
      node.parentId !== undefined &&
      (typeof node.parentId !== 'string' || node.parentId.trim() === '')
    ) {
      errors.push(`Node ${nodeIndex} parentId must be a non-empty string when present`);
    }
    if (node.position !== undefined) {
      const p = node.position;
      if (
        !isRecord(p) ||
        typeof p.x !== 'number' ||
        Number.isNaN(p.x) ||
        typeof p.y !== 'number' ||
        Number.isNaN(p.y)
      ) {
        errors.push(`Node ${nodeIndex} position must be { x: number, y: number }`);
      }
    }
  }

  if (triggerCount !== 1) {
    errors.push('Graph must have exactly one trigger node');
  }
  const candidateNodes = nodes.filter(isRecord) as FlowNode[];
  const candidateById = new Map(candidateNodes.map((node) => [node.id, node]));
  for (const node of candidateNodes) {
    if (node.parentId && candidateById.get(node.parentId)?.blockType !== 'fan_out') {
      errors.push(`Node "${node.id}" parentId must reference a Fan Out node`);
    }
  }

  const edgeIds = new Set<string>();
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i];
    const ei = i + 1;
    if (!isRecord(e)) {
      errors.push(`Edge ${ei} must be an object`);
      continue;
    }
    const eid = e.id;
    const src = e.source;
    const tgt = e.target;
    if (typeof eid !== 'string' || eid.trim() === '') {
      errors.push(`Edge ${ei} must have a non-empty string id`);
    } else if (edgeIds.has(eid)) {
      errors.push(`Edge ${ei} has duplicate id: ${eid}`);
    } else {
      edgeIds.add(eid);
    }
    if (typeof src !== 'string' || src.trim() === '') {
      errors.push(`Edge ${ei} must have a non-empty source`);
    } else if (!nodeIds.has(src)) {
      errors.push(`Edge ${ei} source references unknown node: ${src}`);
    }
    if (typeof tgt !== 'string' || tgt.trim() === '') {
      errors.push(`Edge ${ei} must have a non-empty target`);
    } else if (!nodeIds.has(tgt)) {
      errors.push(`Edge ${ei} target references unknown node: ${tgt}`);
    }
    if (e.sourceHandle !== undefined && typeof e.sourceHandle !== 'string') {
      errors.push(`Edge ${ei} sourceHandle must be a string when present`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  if (!triggerId) {
    return { valid: false, errors: ['Graph must have exactly one trigger node'] };
  }

  for (const e of edges) {
    if (e.target === triggerId) {
      errors.push('Edges must not target the trigger node');
      break;
    }
  }

  const outgoing = new Map<string, FlowEdge[]>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
  }
  for (const e of edges) {
    outgoing.get(e.source)?.push(e);
  }

  const warnings: string[] = [];
  const nodeById = new Map<string, FlowNode>((nodes as FlowNode[]).map((node) => [node.id, node]));

  const triggerOut = outgoing.get(triggerId) ?? [];
  if (triggerOut.length !== 1) {
    if (isRunMode) {
      errors.push('Trigger must have exactly one outgoing edge');
    } else {
      warnings.push(
        `Trigger has ${triggerOut.length === 0 ? 'no' : 'more than one'} outgoing edge — connect it to the first step before running`,
      );
    }
  }

  for (const n of nodes as FlowNode[]) {
    if (!nodeIds.has(n.id)) continue;
    if (n.id === triggerId) continue;
    const outs = outgoing.get(n.id) ?? [];
    const name = formatFlowNodeLabel(n);
    if (n.blockType === 'condition') {
      const hasCorrectCount = outs.length === 2;
      const hasTrue = outs.some((o) => o.sourceHandle === 'true');
      const hasFalse = outs.some((o) => o.sourceHandle === 'false');
      const edgesValid = hasCorrectCount && hasTrue && hasFalse;
      if (!edgesValid) {
        const msg = !hasCorrectCount
          ? `Condition node "${name}" must have exactly two outgoing edges`
          : `Condition node "${name}" must have one outgoing edge with sourceHandle "true" and one with "false"`;
        if (isRunMode) {
          errors.push(msg);
        } else {
          warnings.push(`${msg} (add edges before running)`);
        }
        if (!hasCorrectCount) continue;
      }
    } else if (n.blockType === 'fan_out') {
      // Fan Out completeness and ownership are validated below.
    } else if (n.blockType === 'end') {
      if (outs.length > 0) {
        errors.push(`End node "${name}" must have no outgoing edges`);
      }
    } else if (!isTriggerBlockType(n.blockType)) {
      if (outs.length > 1) {
        if (isRunMode) {
          errors.push(`Node "${name}" (${n.blockType}) may have at most one outgoing edge`);
        } else {
          warnings.push(`Node "${name}" (${n.blockType}) may have at most one outgoing edge`);
        }
      }
    }
  }

  // Fan Out bodies have explicit ownership; the tail's ordinary edge is the continuation.
  for (const n of nodes as FlowNode[]) {
    if (n.blockType !== 'fan_out') continue;
    const resolution = resolveFanOutStructure(nodes as FlowNode[], edges, n.id);
    if (resolution.ok) continue;
    const message = `Fan Out "${formatFlowNodeLabel(n)}" ${resolution.message}`;
    if (resolution.incomplete && !isRunMode)
      warnings.push(`${message} (complete it before running)`);
    else errors.push(message);
  }

  // Cycle detection: back-edges from condition nodes are allowed (loops);
  // back-edges from any other node type are not.
  const backEdgeIds = findBackEdges({ nodes: nodes as FlowNode[], edges });
  for (const eid of backEdgeIds) {
    const e = edges.find((ed) => ed.id === eid);
    if (!e) continue;
    const srcNode = nodeById.get(e.source);
    if (srcNode?.blockType !== 'condition') {
      errors.push(
        `Node "${srcNode ? formatFlowNodeLabel(srcNode) : e.source}" creates a cycle — only condition nodes may loop back`,
      );
    }
  }

  // For each condition node that participates in a loop, warn unless it also has
  // a forward (non-looping) exit path; error if BOTH handles loop back.
  for (const n of nodes as FlowNode[]) {
    if (n.blockType !== 'condition' || !nodeIds.has(n.id)) continue;
    const outs = outgoing.get(n.id) ?? [];
    const trueEdge = outs.find((o) => o.sourceHandle === 'true');
    const falseEdge = outs.find((o) => o.sourceHandle === 'false');
    const trueLoops = trueEdge ? backEdgeIds.has(trueEdge.id) : false;
    const falseLoops = falseEdge ? backEdgeIds.has(falseEdge.id) : false;
    const name = formatFlowNodeLabel(n);
    if (trueLoops && falseLoops) {
      errors.push(`Condition node "${name}" has no exit path — both branches loop back`);
    } else if (trueLoops || falseLoops) {
      warnings.push(
        `Condition node "${name}" creates a loop — make sure your condition has an exit path`,
      );
    }

    // Validate loop config when present
    const loopCfg = isRecord(n.config) ? n.config.loop : undefined;
    if (loopCfg !== undefined) {
      if (!isRecord(loopCfg)) {
        errors.push(`Condition node "${name}" loop config must be an object`);
      } else {
        const maxIter = loopCfg.maxIterations;
        if (
          typeof maxIter !== 'number' ||
          !Number.isInteger(maxIter) ||
          maxIter < 1 ||
          maxIter > 50
        ) {
          errors.push(
            `Condition node "${name}" loop.maxIterations must be an integer between 1 and 50`,
          );
        }
        const onMax = loopCfg.onMaxReached;
        if (onMax !== undefined && onMax !== 'fail' && onMax !== 'continue') {
          errors.push(`Condition node "${name}" loop.onMaxReached must be "fail" or "continue"`);
        }
      }
    }
  }

  const seen = reachableFromTrigger(triggerId, nodeIds, edges);
  for (const id of nodeIds) {
    if (id !== triggerId && !seen.has(id)) {
      const ref = nodeById.get(id);
      const label = ref ? formatFlowNodeLabel(ref) : id;
      warnings.push(`Node "${label}" is not reachable from the trigger (may be mid-edit)`);
    }
  }

  // A saved binding outlives the catalog: rename or drop the event and the flow still looks
  // fine while nothing can ever match it. Warn (never error) so an existing graph still saves.
  const webhookProvider = options?.webhookProvider
    ? getProviderById(options.webhookProvider)
    : undefined;
  if (webhookProvider) {
    for (const n of nodeById.values()) {
      if (n.blockType !== 'webhook_trigger') continue;
      const et = n.config?.eventType;
      if (!et || webhookProvider.events.some((e) => e.id === et)) continue;
      warnings.push(
        `Trigger event '${String(et)}' no longer exists for ${webhookProvider.display_name} — pick an event`,
      );
    }
  }

  // Per-block config validation: only enforced at run time (mode='run').
  // In save mode these are skipped so agents can build flows incrementally.
  if (isRunMode) {
    for (const n of nodes as FlowNode[]) {
      if (n.blockType !== 'http_request') continue;
      const c = n.config ?? {};
      const wName = formatFlowNodeLabel(n);
      const url = typeof c.url === 'string' ? c.url.trim() : '';
      if (!url) {
        errors.push(`HTTP Request node "${wName}" has no URL`);
      } else if (url.length > HTTP_REQUEST_MAX_URL_LENGTH) {
        errors.push(`HTTP Request node "${wName}" URL exceeds maximum length`);
      } else {
        try {
          const u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            errors.push(`HTTP Request node "${wName}" URL must use http or https`);
          }
        } catch {
          errors.push(`HTTP Request node "${wName}" has an invalid URL`);
        }
      }
      const body = typeof c.body === 'string' ? c.body : '';
      if (body.length > 0) {
        const bytes = new TextEncoder().encode(body).length;
        if (bytes > HTTP_REQUEST_MAX_BODY_UTF8_BYTES) {
          warnings.push(`HTTP Request node "${wName}" body exceeds maximum size`);
        }
      }
      if (c.headers !== undefined) {
        let serialized = '';
        try {
          serialized = JSON.stringify(c.headers);
        } catch {
          serialized = '';
        }
        if (serialized.length > 0) {
          const bytes = new TextEncoder().encode(serialized).length;
          if (bytes > HTTP_REQUEST_MAX_HEADERS_JSON_BYTES) {
            warnings.push(`HTTP Request node "${wName}" headers exceed maximum serialized size`);
          }
        }
      }
    }

    for (const n of nodes as FlowNode[]) {
      if (n.blockType !== 'webhook_trigger') continue;
      const c = n.config ?? {};
      const iid = typeof c.integrationId === 'string' ? c.integrationId.trim() : '';
      const et = typeof c.eventType === 'string' ? c.eventType.trim() : '';
      const wName = formatFlowNodeLabel(n);
      if (!iid) {
        errors.push(`Webhook trigger node "${wName}" has no integration selected`);
      }
      if (!et) {
        errors.push(`Webhook trigger node "${wName}" has no event type selected`);
      }
    }

    const RUN_COMMAND_WORKING_DIRS = ['project_root', 'trigger_worktree', 'custom'] as const;

    for (const n of nodes as FlowNode[]) {
      if (n.blockType !== 'agent') continue;
      const c = n.config ?? {};
      const wName = formatFlowNodeLabel(n);
      if (typeof c.instructions !== 'string' || (c.instructions as string).trim().length === 0) {
        errors.push(`Agent node "${wName}" must have instructions`);
      }
      if (c.fireAndForget !== undefined && typeof c.fireAndForget !== 'boolean') {
        errors.push(`Agent node "${wName}" fireAndForget must be a boolean when present`);
      }
      const upstream = findUpstreamSession(nodes as FlowNode[], edges, n, AGENT_SESSION_SOURCES);
      if (upstream === 'lane-only') {
        errors.push(`Agent node "${wName}" ${AFTER_FAN_OUT_NEEDS_OUTER_START}`);
      } else if (upstream === 'none') {
        errors.push(
          `Agent node "${wName}" requires an upstream Start Task node to create the task`,
        );
      }
    }

    for (const n of nodes as FlowNode[]) {
      if (n.blockType !== 'start_task') continue;
      const c = n.config ?? {};
      const wName = formatFlowNodeLabel(n);
      if (c.startInWorktree !== undefined && typeof c.startInWorktree !== 'boolean') {
        errors.push(`Start Task node "${wName}" startInWorktree must be a boolean when present`);
      }
      if (
        c.startInWorktree === true &&
        c.branch !== undefined &&
        c.branch !== null &&
        typeof c.branch !== 'string'
      ) {
        errors.push(`Start Task node "${wName}" branch must be a string when present`);
      }
    }

    for (const n of nodes as FlowNode[]) {
      if (n.blockType !== 'run_command') continue;
      const c = n.config ?? {};
      const wName = formatFlowNodeLabel(n);
      if (typeof c.command !== 'string' || (c.command as string).trim().length === 0) {
        errors.push(`Run Command node "${wName}" must have a non-empty command`);
      }
      if (
        c.workingDirectory !== undefined &&
        !RUN_COMMAND_WORKING_DIRS.includes(
          c.workingDirectory as (typeof RUN_COMMAND_WORKING_DIRS)[number],
        )
      ) {
        errors.push(
          `Run Command node "${wName}" workingDirectory must be one of: ${RUN_COMMAND_WORKING_DIRS.join(', ')}`,
        );
      }
      if (
        c.workingDirectory === 'custom' &&
        (typeof c.customPath !== 'string' || (c.customPath as string).trim().length === 0)
      ) {
        errors.push(
          `Run Command node "${wName}" customPath must be a non-empty string when workingDirectory is 'custom'`,
        );
      }
    }

    for (const n of nodes as FlowNode[]) {
      if (n.blockType !== 'fan_out') continue;
      const c = n.config ?? {};
      const wName = formatFlowNodeLabel(n);
      if (c.mode !== undefined && c.mode !== 'sequential' && c.mode !== 'parallel') {
        errors.push(`Fan Out node "${wName}" mode must be "sequential" or "parallel" when set`);
      }
      if (c.mode === 'parallel') {
        if (c.maxParallel !== undefined) {
          const mp = c.maxParallel;
          if (
            typeof mp !== 'number' ||
            !Number.isInteger(mp) ||
            (mp as number) < 1 ||
            (mp as number) > 10
          ) {
            errors.push(`Fan Out node "${wName}" maxParallel must be an integer between 1 and 10`);
          }
        }
      }
    }

    const triggerNodeForChatReply = (nodes as FlowNode[]).find((nd) => nd.id === triggerId);
    const triggerProvidesChatIdForReply =
      triggerNodeForChatReply?.blockType === 'post_task_trigger';

    for (const n of nodes as FlowNode[]) {
      if (n.blockType !== 'chat_reply') continue;
      const c = n.config ?? {};
      const wName = formatFlowNodeLabel(n);
      for (const warning of chatReplyTemplateWarnings(c)) {
        warnings.push(`Chat Reply node "${wName}" ${warning}`);
      }
      if (
        !LAUNCH_FLAGS.flowHtmlArtifacts &&
        parseChatReplyTemplateConfig(c).contentType === 'html_artifact'
      ) {
        errors.push(
          `Chat Reply node "${wName}" is set to an interactive view, which is turned off. Switch it to a text message.`,
        );
      }
      if (!triggerProvidesChatIdForReply) {
        const upstream = findUpstreamSession(
          nodes as FlowNode[],
          edges,
          n,
          CHAT_REPLY_SESSION_SOURCES,
        );
        if (upstream === 'lane-only') {
          errors.push(`Chat Reply node "${wName}" ${AFTER_FAN_OUT_NEEDS_OUTER_START}`);
        } else if (upstream === 'none') {
          errors.push(
            `Chat Reply node "${wName}" requires an upstream Start Task node or a Post-Task trigger to provide the chat session`,
          );
        }
      }
    }
  } // end isRunMode per-block config checks

  if (errors.length > 0) {
    return warnings.length > 0 ? { valid: false, errors, warnings } : { valid: false, errors };
  }

  return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
}

/** Build a linear chain: trigger → … with sequential edges (for tests / defaults). */
export function linearFlowGraph(nodeList: Omit<FlowNode, 'position'>[]): FlowGraph {
  const nodes: FlowNode[] = nodeList.map((n) => ({ ...n }));
  const edges: FlowEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a === undefined || b === undefined) continue;
    edges.push({
      id: `e-${a.id}-${b.id}`,
      source: a.id,
      target: b.id,
    });
  }
  return { nodes, edges };
}

/**
 * Normalize flow graph from persisted format.
 * Accepts:
 * - `{ nodes, edges }` object (current format)
 * - Legacy array format: `Omit<FlowNode, 'position'>[]` (converted via linearFlowGraph)
 *
 * Returns null if input is invalid or malformed.
 */
export function normalizeFlowGraph(raw: unknown): FlowGraph | null {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.nodes) && Array.isArray(o.edges)) {
      return {
        nodes: o.nodes as FlowNode[],
        edges: o.edges as FlowEdge[],
        ...(isRecord(o.settings) ? { settings: o.settings as FlowSettings } : {}),
      };
    }
  }
  // Legacy array format: validate each element has required FlowNode fields before calling linearFlowGraph
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) return null;
      if (typeof item.id !== 'string' || item.id.trim() === '') return null;
      if (
        typeof item.blockType !== 'string' ||
        (!isRegisteredBlockType(item.blockType) && !isCustomNodeBlockType(item.blockType))
      )
        return null;
    }
    return linearFlowGraph(raw as Omit<FlowNode, 'position'>[]);
  }
  return null;
}

/** True when two flow graphs are content-equal (key-order-insensitive, array-order-sensitive). */
export function flowGraphsEqual(a: FlowGraph, b: FlowGraph): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}
