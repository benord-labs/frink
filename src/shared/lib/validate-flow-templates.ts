/* eslint-disable max-lines, max-lines-per-function */
/**
 * Design-time template variable analysis for Frink Flows.
 *
 * Provides `validateFlowTemplateVariables` (warns about unresolvable `{{...}}` refs) and
 * `computeNodeVariables` (the exact fields available per node).
 *
 * Used by MCP flow tools (`frink_flows_patch`) and the Flow editor for static analysis.
 *
 * DESIGN-TIME ONLY — validates the FLAT `{{previous.<field>}}` contract. Runtime rendering lives
 * in src/main/lib/flows/template-utils.ts.
 */

import { reservedPluginIdForNodeName } from '../integrations/plugin-nodes';
import { TRIGGER_FIELD_ALIASES } from '../integrations/trigger-field-aliases';
import { isCustomNodeBlockType } from './block-registry';
import { resolveFanOutStructure } from './compute-fan-out-body-chain';
import { getTemplateRenderedFields } from './flows/template-rendered-fields';
import {
  CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA,
  LOOP_CONTEXT_SCHEMA,
  OUTPUT_SCHEMAS,
  type OutputFieldSchema,
  type RunCommandExpectedOutputs,
  resolveRunCommandOutputSchema,
  TRIGGER_ALLOWS_ARBITRARY_KEYS,
  TRIGGER_SCHEMAS,
  type TriggerFieldSchema,
} from './output-schemas';
import { findShellTemplateWarnings, type ShellWarningFields } from './shell-template/warnings';
import { TEMPLATE_VARIABLE_PATTERN } from './template-constants';
import type { FlowEdge, FlowGraph, FlowNode } from './validate-flow-graph';

export type NodeVariables = {
  /** Fields available as `{{previous.*}}` from the resolved predecessor schema. */
  previous: OutputFieldSchema[];
  /** Fields available as `{{trigger.*}}` from the flow's trigger type. */
  trigger: TriggerFieldSchema[];
  /** Fields available as `{{loop.*}}` — null when node is not in a fan_out body chain. */
  loop: OutputFieldSchema[] | null;
  /** Always null: the `{{flow.*}}` scope is retired (the Flow Briefing rides the session system prompt,
   *  not a template var). Kept for shape stability with the Available Variables panel. */
  flow: OutputFieldSchema[] | null;
  /** Advisory notes (e.g. "run_command may produce additional JSON stdout fields"). */
  notes: string[];
  /** Block type hasDynamic is attributable to (walks passthrough); unset once a diamond merge makes it ambiguous. */
  singlePredecessorBlockType?: string;
  /** True when the trigger type accepts arbitrary `{{trigger.*}}` keys (e.g. manual_trigger
   * batch flows) — undeclared keys should render yellow (dynamic), not red (invalid). */
  allowsArbitraryTriggerKeys?: boolean;
};

/** Optional enrichment for `computeNodeVariables` (e.g. custom node manifest outputs from tRPC). */
export type ComputeNodeVariablesOptions = {
  /**
   * Map of custom node `blockType` → output fields from manifest.
   * When set for a type, replaces the generic custom-node fallback schema.
   */
  customNodeOutputs?: ReadonlyMap<string, OutputFieldSchema[]>;
  /**
   * Provider slug (shortcut, github, …) of the flow's webhook trigger integration.
   * The renderer resolves it from the trigger node's integrationId; when set, the
   * provider's friendly aliases ({{trigger.story.title}} etc.) are added as known
   * trigger fields so they validate + autocomplete. Omitted off-renderer (MCP/save).
   */
  webhookProvider?: string;
};

export type TemplateVariableWarning = ShellWarningFields & {
  nodeId: string;
  field: string;
  placeholder: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract `{{path}}` placeholder paths from a template string. */
function extractTemplatePaths(template: string): string[] {
  if (typeof template !== 'string') return [];
  const regex = new RegExp(TEMPLATE_VARIABLE_PATTERN, 'g');
  const paths: string[] = [];
  for (const match of template.matchAll(regex)) {
    const path = match[1]?.trim();
    if (path) paths.push(path);
  }
  return paths;
}

/** Build adjacency maps for efficient graph traversal. */
function buildAdjacency(edges: FlowEdge[]): {
  predecessorsOf: Map<string, string[]>;
} {
  const predecessorsOf = new Map<string, string[]>();
  for (const e of edges) {
    const preds = predecessorsOf.get(e.target) ?? [];
    preds.push(e.source);
    predecessorsOf.set(e.target, preds);
  }
  return { predecessorsOf };
}

/** Returns the blockType of a node by id, or undefined if not found. */
function getBlockType(nodes: FlowNode[], nodeId: string): string | undefined {
  return nodes.find((n) => n.id === nodeId)?.blockType;
}

/**
 * Extracts a validated `RunCommandExpectedOutputs` from a node config, or null if absent/invalid.
 */
function extractExpectedOutputs(
  nodeConfig: Record<string, unknown> | null | undefined,
): RunCommandExpectedOutputs | null {
  const eo = nodeConfig?.expectedOutputs;
  if (!eo || typeof eo !== 'object' || Array.isArray(eo)) return null;
  const entries = Object.entries(eo as Record<string, unknown>);
  if (entries.length === 0) return null;
  // Light validation: each value must be an object with a `type` string
  for (const [, v] of entries) {
    if (!v || typeof v !== 'object' || typeof (v as Record<string, unknown>).type !== 'string') {
      return null;
    }
  }
  return eo as RunCommandExpectedOutputs;
}

/** Output field schemas for a built-in or custom block type. Uses `expectedOutputs` for
 * `run_command` when declared, else the static exitCode/_rawStdout schema. No condition
 * passthrough here — use resolveEffectivePredecessorSchema for that. */
function getBlockOutputSchema(
  blockType: string,
  nodeConfig?: Record<string, unknown> | null,
  customNodeOutputs?: ReadonlyMap<string, OutputFieldSchema[]>,
): OutputFieldSchema[] {
  if (blockType === 'run_command') {
    const expectedOutputs = extractExpectedOutputs(nodeConfig);
    if (expectedOutputs) return resolveRunCommandOutputSchema(expectedOutputs);
  }
  if (OUTPUT_SCHEMAS[blockType]) return OUTPUT_SCHEMAS[blockType];
  if (isCustomNodeBlockType(blockType)) {
    const enriched = customNodeOutputs?.get(blockType);
    if (enriched && enriched.length > 0) return enriched;
    // A plugin node returns the provider's response envelope, so run_command's fallback fields
    // can never appear. A catalog action that declares no outputs declares nothing (sc-2508).
    if (reservedPluginIdForNodeName(blockType) !== undefined) return [];
    return CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA;
  }
  return [];
}

/** True when the predecessor can produce dynamic output fields beyond its declared schema
 * (run_command without expectedOutputs, or any custom node). */
function hasDynamicOutputs(
  blockType: string,
  nodeConfig?: Record<string, unknown> | null,
): boolean {
  if (blockType === 'run_command') {
    // Declared expectedOutputs means the user has stated the contract — treat as static
    return extractExpectedOutputs(nodeConfig) === null;
  }
  return isCustomNodeBlockType(blockType);
}

type PredecessorSchema = {
  fields: OutputFieldSchema[];
  /** Advisory: predecessor may produce extra fields not in the schema. */
  hasDynamic: boolean;
  /** Block type hasDynamic is attributable to (walks passthrough); unset once a diamond merge makes it ambiguous. */
  attributableBlockType?: string;
};

/**
 * Returns the effective output schema for a single node — what it outputs as `outputs`
 * when it completes, factoring in passthrough behaviour:
 * - condition: spreads its own predecessor's outputs + adds `result`
 * - approval: no outputs (flow pauses) — returns empty
 * - all others: their declared OUTPUT_SCHEMAS entry
 *
 * `visitedOutput` tracks nodes whose output we are currently computing to break
 * direct output-schema cycles (distinct from the backward-walk visited set).
 */
function getEffectiveOutputSchemaForNode(
  nodes: FlowNode[],
  predecessorsOf: Map<string, string[]>,
  nodeId: string,
  visitedOutput: Set<string>,
  customNodeOutputs?: ReadonlyMap<string, OutputFieldSchema[]>,
): PredecessorSchema {
  if (visitedOutput.has(nodeId)) return { fields: [], hasDynamic: false };
  const nextVisited = new Set(visitedOutput);
  nextVisited.add(nodeId);

  const node = nodes.find((n) => n.id === nodeId);
  const blockType = node?.blockType;
  if (!blockType) return { fields: [], hasDynamic: false };

  const nodeConfig =
    node.config && typeof node.config === 'object' && !Array.isArray(node.config)
      ? (node.config as Record<string, unknown>)
      : null;

  // Condition: spreads its upstream outputs + adds own `result` key.
  if (blockType === 'condition') {
    const upstream = resolveEffectivePredecessorSchema(
      nodes,
      predecessorsOf,
      nodeId,
      new Set<string>(),
      nextVisited,
      customNodeOutputs,
    );
    const conditionFields = OUTPUT_SCHEMAS.condition ?? [];
    return {
      fields: mergeSchemaFields(upstream.fields, conditionFields),
      hasDynamic: upstream.hasDynamic,
      attributableBlockType: upstream.attributableBlockType,
    };
  }

  // Approval: pauses the flow, produces no outputs
  if (blockType === 'approval') {
    return { fields: [], hasDynamic: false };
  }

  return {
    fields: getBlockOutputSchema(blockType, nodeConfig, customNodeOutputs),
    hasDynamic: hasDynamicOutputs(blockType, nodeConfig),
    attributableBlockType: blockType,
  };
}

/**
 * Resolves the schema available as `{{previous.*}}` for a target node.
 * Walks backward through approval nodes (no outputs) and handles diamond merges.
 *
 * `visitedWalk` prevents infinite backward-walk recursion on condition back-edges.
 * `visitedOutput` is threaded through to `getEffectiveOutputSchemaForNode` to break
 * output-schema computation cycles independently.
 */
function resolveEffectivePredecessorSchema(
  nodes: FlowNode[],
  predecessorsOf: Map<string, string[]>,
  nodeId: string,
  visitedWalk = new Set<string>(),
  visitedOutput = new Set<string>(),
  customNodeOutputs?: ReadonlyMap<string, OutputFieldSchema[]>,
): PredecessorSchema {
  if (visitedWalk.has(nodeId)) return { fields: [], hasDynamic: false };
  const nextWalk = new Set(visitedWalk);
  nextWalk.add(nodeId);

  const predIds = predecessorsOf.get(nodeId) ?? [];

  if (predIds.length === 0) {
    return { fields: [], hasDynamic: false };
  }

  if (predIds.length === 1) {
    const predId = predIds[0] as string;
    const predBlockType = getBlockType(nodes, predId);
    if (!predBlockType) return { fields: [], hasDynamic: false };

    // Approval: no outputs — skip it and look further upstream
    if (predBlockType === 'approval') {
      return resolveEffectivePredecessorSchema(
        nodes,
        predecessorsOf,
        predId,
        nextWalk,
        visitedOutput,
        customNodeOutputs,
      );
    }

    return getEffectiveOutputSchemaForNode(
      nodes,
      predecessorsOf,
      predId,
      new Set(visitedOutput),
      customNodeOutputs,
    );
  }

  // Diamond merge: union the actual output schemas of all predecessors
  const all: PredecessorSchema[] = predIds.map((predId) =>
    getEffectiveOutputSchemaForNode(
      nodes,
      predecessorsOf,
      predId,
      new Set(visitedOutput),
      customNodeOutputs,
    ),
  );
  const merged = all.reduce<OutputFieldSchema[]>((acc, s) => mergeSchemaFields(acc, s.fields), []);
  const anyDynamic = all.some((s) => s.hasDynamic);
  return { fields: merged, hasDynamic: anyDynamic };
}

/**
 * Merges two field schema arrays, deduplicating by key (b takes precedence on conflict).
 */
function mergeSchemaFields(a: OutputFieldSchema[], b: OutputFieldSchema[]): OutputFieldSchema[] {
  const map = new Map<string, OutputFieldSchema>();
  for (const f of a) map.set(f.key, f);
  for (const f of b) map.set(f.key, f);
  return Array.from(map.values());
}

/**
 * Explicit `parentId` ownership identifies every node inside a Fan Out branch.
 */
function computeFanOutBodyMembers(nodes: FlowNode[]): Set<string> {
  return new Set(nodes.filter((node) => node.parentId).map((node) => node.id));
}

/** Detect the trigger type from the graph's single trigger node blockType. */
function detectTriggerType(nodes: FlowNode[]): string | undefined {
  const triggerBlockTypes = new Set([
    'manual_trigger',
    'webhook_trigger',
    'post_task_trigger',
    'schedule_trigger',
  ]);
  return nodes.find((n) => triggerBlockTypes.has(n.blockType))?.blockType;
}

// ---------------------------------------------------------------------------
// Batch trigger schema helpers
// ---------------------------------------------------------------------------

/** Matches `flowSettingsShapeSchema` / BatchTriggerSchemaItem `type` enum. */
const BATCH_TRIGGER_SCHEMA_ITEM_TYPES = new Set<string>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
]);

function parseBatchTriggerFieldType(raw: unknown): TriggerFieldSchema['type'] {
  if (typeof raw === 'string' && BATCH_TRIGGER_SCHEMA_ITEM_TYPES.has(raw)) {
    return raw as TriggerFieldSchema['type'];
  }
  return 'string';
}

/**
 * Merges declared batchTriggerSchema entries into the base trigger fields array.
 * Only called when the trigger type is in TRIGGER_ALLOWS_ARBITRARY_KEYS.
 *
 * Rules:
 * - Declared fields that duplicate an existing key are skipped (static schema wins).
 * - Malformed schema input is ignored gracefully (no crash).
 * - An empty or absent batchTriggerSchema returns baseTriggerFields unchanged.
 */
function mergeBatchTriggerFields(
  baseTriggerFields: TriggerFieldSchema[],
  batchTriggerSchema: { key: string; type: string; description?: string }[] | undefined,
): TriggerFieldSchema[] {
  if (!batchTriggerSchema || batchTriggerSchema.length === 0) return baseTriggerFields;
  const existingKeys = new Set(baseTriggerFields.map((f) => f.key));
  const extra: TriggerFieldSchema[] = [];
  for (const item of batchTriggerSchema) {
    if (typeof item?.key !== 'string' || existingKeys.has(item.key)) continue;
    const fieldType = parseBatchTriggerFieldType(item.type);
    extra.push({
      key: item.key,
      type: fieldType,
      description: item.description ?? `Batch-injected trigger variable: ${item.key}`,
    });
  }
  return extra.length === 0 ? baseTriggerFields : [...baseTriggerFields, ...extra];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the exact template variables available to each node in the graph.
 *
 * Returns a map of nodeId → NodeVariables describing available `{{previous.*}}`,
 * `{{trigger.*}}`, and `{{loop.*}}` fields for that node position (the `{{flow.*}}` scope is retired).
 */
export function computeNodeVariables(
  graph: FlowGraph,
  options?: ComputeNodeVariablesOptions,
): Record<string, NodeVariables> {
  const { nodes, edges } = graph;
  const { predecessorsOf } = buildAdjacency(edges);
  const triggerType = detectTriggerType(nodes);
  const baseTriggerFields: TriggerFieldSchema[] = triggerType
    ? (TRIGGER_SCHEMAS[triggerType] ?? [])
    : [];

  // Merge batchTriggerSchema declared fields as typed chips when the trigger allows
  // arbitrary keys (i.e. manual_trigger batch flows). Dedup by key — schema-declared wins.
  const envelopeTriggerFields: TriggerFieldSchema[] =
    triggerType && TRIGGER_ALLOWS_ARBITRARY_KEYS.has(triggerType)
      ? mergeBatchTriggerFields(baseTriggerFields, graph.settings?.batchTriggerSchema)
      : baseTriggerFields;

  // Friendly per-provider aliases ({{trigger.story.title}} etc.) become known
  // trigger fields (key = full alias path) when the renderer supplies the webhook
  // provider — so they validate `valid` + autocomplete. Off-renderer (no provider)
  // they're absent and `{{trigger.story.title}}` would warn — acceptable: the static
  // validator can't resolve integrationId → provider (that needs the cloud API).
  const aliasTriggerFields: TriggerFieldSchema[] =
    triggerType === 'webhook_trigger' && options?.webhookProvider
      ? (TRIGGER_FIELD_ALIASES[options.webhookProvider] ?? []).map((a) => ({
          key: a.alias,
          type: a.type,
          description: a.description ?? a.label,
        }))
      : [];
  const triggerFields: TriggerFieldSchema[] = [...envelopeTriggerFields, ...aliasTriggerFields];
  const fanOutBodyMembers = computeFanOutBodyMembers(nodes);
  const continuationIds = new Set(
    nodes.flatMap((node) => {
      if (node.blockType !== 'fan_out') return [];
      const resolution = resolveFanOutStructure(nodes, edges, node.id);
      return resolution.ok ? [resolution.structure.continuationNodeId] : [];
    }),
  );
  const customNodeOutputs = options?.customNodeOutputs;

  const result: Record<string, NodeVariables> = {};

  for (const node of nodes) {
    const predecessor = continuationIds.has(node.id)
      ? {
          fields: OUTPUT_SCHEMAS.fan_out_completed ?? [],
          hasDynamic: false,
          attributableBlockType: 'fan_out',
        }
      : resolveEffectivePredecessorSchema(
          nodes,
          predecessorsOf,
          node.id,
          new Set(),
          new Set(),
          customNodeOutputs,
        );

    const inLoop = fanOutBodyMembers.has(node.id);
    const loopFields: OutputFieldSchema[] | null = inLoop
      ? [
          ...LOOP_CONTEXT_SCHEMA,
          {
            key: 'currentItem',
            type: 'unknown',
            description:
              'Current array element for this iteration — shape depends on the upstream array. Use dot notation for object fields: {{loop.currentItem.title}}',
            guaranteed: true,
          },
        ]
      : null;

    const notes: string[] = [];
    if (predecessor.hasDynamic) {
      notes.push(
        'The immediate predecessor may produce additional output fields when stdout is valid JSON. These dynamic fields can be referenced as {{previous.<fieldName>}} even if not listed above.',
      );
    }

    // {{flow.briefing}} is retired: the Flow Briefing is delivered once per session via the system
    // prompt, so every agent already sees it and there is no inline var to pull it
    // in. Not advertised for any node; an existing `{{flow.briefing}}` resolves to '' (advisory-only).
    const flowFields: OutputFieldSchema[] | null = null;

    result[node.id] = {
      previous: predecessor.fields,
      trigger: triggerFields,
      loop: loopFields,
      flow: flowFields,
      notes,
      allowsArbitraryTriggerKeys:
        triggerType != null && TRIGGER_ALLOWS_ARBITRARY_KEYS.has(triggerType) ? true : undefined,
      singlePredecessorBlockType: predecessor.attributableBlockType,
    };
  }

  return result;
}

/**
 * Validates template variable references in a flow graph.
 *
 * Checks `{{previous.*}}`, `{{trigger.*}}`, and `{{loop.*}}` placeholders in
 * template-rendered config fields against the statically known output schemas.
 *
 * Only scans fields that are actually template-rendered at runtime:
 *   run_command.command, start_task.label, start_task.branch,
 *   agent.instructions, chat_reply.messageTemplate, and every top-level string custom-node input
 *
 * Returns advisory warnings — never hard errors. Unknown fields on run_command
 * or custom node predecessors are silently allowed (JSON stdout is dynamic).
 */
export function validateFlowTemplateVariables(
  graph: FlowGraph,
  precomputedNodeVariables?: Record<string, NodeVariables>,
): TemplateVariableWarning[] {
  const { nodes, edges } = graph;
  const warnings: TemplateVariableWarning[] = findShellTemplateWarnings(nodes);

  const { predecessorsOf } = buildAdjacency(edges);
  const triggerType = detectTriggerType(nodes);
  const triggerFields: TriggerFieldSchema[] = triggerType
    ? (TRIGGER_SCHEMAS[triggerType] ?? [])
    : [];
  const fanOutBodyMembers = computeFanOutBodyMembers(nodes);
  const nodeVariables = precomputedNodeVariables ?? computeNodeVariables(graph);

  // Warn about templates in non-rendered fields (e.g. run_command.customPath)
  for (const node of nodes) {
    const config = node.config;
    if (!config || typeof config !== 'object') continue;

    for (const [field, value] of Object.entries(config)) {
      if (typeof value !== 'string') continue;
      const paths = extractTemplatePaths(value);
      if (paths.length === 0) continue;

      const renderedFields = getTemplateRenderedFields(node.blockType, node.config);
      if (renderedFields.includes(field)) continue;

      // Field has template syntax but is NOT template-rendered
      for (const path of paths) {
        const specialNote =
          node.blockType === 'run_command' && field === 'customPath'
            ? 'customPath is intentionally not template-rendered (path traversal prevention)'
            : `"${field}" is not template-rendered for ${node.blockType} nodes`;

        warnings.push({
          nodeId: node.id,
          field,
          placeholder: `{{${path}}}`,
          message: `Template variable {{${path}}} in config field "${field}" will not be resolved at runtime — ${specialNote}.`,
        });
      }
    }
  }

  // Validate template variables in rendered fields
  for (const node of nodes) {
    const renderedFields = getTemplateRenderedFields(node.blockType, node.config);
    if (renderedFields.length === 0) continue;

    const config = node.config;
    if (!config || typeof config !== 'object') continue;

    const vars = nodeVariables[node.id];
    if (!vars) continue;

    for (const field of renderedFields) {
      const value = (config as Record<string, unknown>)[field];
      if (typeof value !== 'string') continue;

      const paths = extractTemplatePaths(value);

      for (const path of paths) {
        const segments = path.split('.');
        const root = segments[0];

        if (root === 'previous') {
          checkPreviousPath(node, field, path, segments, vars, predecessorsOf, warnings);
        } else if (root === 'trigger') {
          checkTriggerPath(node, field, path, segments, triggerType, triggerFields, warnings);
        } else if (root === 'loop') {
          checkLoopPath(node, field, path, segments, fanOutBodyMembers, warnings);
        } else if (root === 'flow') {
          if (node.blockType !== 'agent') {
            warnings.push({
              nodeId: node.id,
              field,
              placeholder: `{{${path}}}`,
              message: `{{${path}}} is only available in agent block instructions. It will not resolve in ${node.blockType} nodes.`,
            });
          }
        }
        // Other unknown roots are handled gracefully at runtime (left as literal).
      }
    }
  }

  // The Flow Briefing renders once per run against {{trigger.*}} ONLY — it is shared across the whole
  // flow (constant per run) and delivered via the session system prompt, not per node. So only trigger
  // vars resolve; {{previous.*}}/{{loop.*}} (per-node/per-iteration) and the retired {{flow.*}} do not.
  // Validate each briefing path once, attributed to the first agent node (the briefing reaches agents).
  const rawBriefing = graph.settings?.briefing;
  if (rawBriefing && typeof rawBriefing === 'string') {
    const briefingPaths = extractTemplatePaths(rawBriefing);
    const firstAgentNode = nodes.find((n) => n.blockType === 'agent');
    if (firstAgentNode && briefingPaths.length > 0) {
      for (const path of briefingPaths) {
        const segments = path.split('.');
        const root = segments[0];
        if (root === 'trigger') {
          checkTriggerPath(
            firstAgentNode,
            'briefing',
            path,
            segments,
            triggerType,
            triggerFields,
            warnings,
          );
        } else if (root === 'previous' || root === 'loop' || root === 'flow') {
          warnings.push({
            nodeId: firstAgentNode.id,
            field: 'briefing',
            placeholder: `{{${path}}}`,
            message: `{{${path}}} will not resolve in a Flow Briefing. The briefing is shared across the whole flow and rendered once against {{trigger.*}} only — per-node ({{previous.*}}, {{loop.*}}) and {{flow.*}} references are not available here.`,
          });
        }
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Per-root validators
// ---------------------------------------------------------------------------

/** Undeclared `{{previous.<key>}}` after a machine-owned plugin node: its `outputs` are re-derived
 *  from the catalog, so manifest/re-register advice prescribes an edit the spawner discards. */
function pluginPreviousWarningMessage(
  path: string,
  key: string,
  declared: string,
  pluginId: string,
  predType: string,
): string {
  return `{{${path}}} is not a declared output field. Declared: ${declared}. It may still resolve at runtime if ${pluginId} returns "${key}" in its response. Prefer a declared field: "${predType}" is a machine-owned ${pluginId} plugin node whose outputs come from the plugin catalog, so "${key}" cannot be added to its manifest.`;
}

function checkPreviousPath(
  node: FlowNode,
  field: string,
  path: string,
  segments: string[],
  vars: NodeVariables,
  predecessorsOf: Map<string, string[]>,
  warnings: TemplateVariableWarning[],
): void {
  const key = segments[1];
  if (!key) return;

  // Plugin nodes wear the custom-node blockType grammar, so every branch below would otherwise
  // reach for run_command or manifest wording that cannot apply to them. Answered once, up front.
  const predType = vars.singlePredecessorBlockType;
  const pluginId = predType === undefined ? undefined : reservedPluginIdForNodeName(predType);
  if (predType !== undefined && pluginId !== undefined) {
    if (vars.previous.some((f) => f.key === key)) return;
    const declared = vars.previous.map((f) => `previous.${f.key}`).join(', ') || '(none)';
    warnings.push({
      nodeId: node.id,
      field,
      placeholder: `{{${path}}}`,
      message: pluginPreviousWarningMessage(path, key, declared, pluginId, predType),
    });
    return;
  }

  const isDynamic = vars.notes.some((n) => n.includes('dynamic'));

  if (vars.previous.length === 0) {
    const predIds = predecessorsOf.get(node.id) ?? [];
    if (predIds.length === 0) {
      warnings.push({
        nodeId: node.id,
        field,
        placeholder: `{{${path}}}`,
        message: `{{${path}}} references previous outputs but this node has no predecessor.`,
      });
    } else {
      // Predecessor exists but produces no declared outputs (e.g. trigger node).
      // Use {{trigger.*}} for trigger context instead.
      warnings.push({
        nodeId: node.id,
        field,
        placeholder: `{{${path}}}`,
        message: `{{${path}}} references previous outputs but the predecessor node produces no outputs. Available: (none). If the predecessor is a trigger node, use {{trigger.*}} for trigger context instead.`,
      });
    }
    return;
  }

  const matchedField = vars.previous.find((f) => f.key === key);
  if (matchedField) return;

  const available = vars.previous.map((f) => `previous.${f.key}`).join(', ');

  if (isDynamic) {
    // Predecessor CAN produce dynamic fields, but this key isn't declared (see NodeVariables.singlePredecessorBlockType's doc for the attribution rule).
    const predType = vars.singlePredecessorBlockType;
    const actionHint =
      predType === undefined
        ? `ACTION REQUIRED: identify the dynamic predecessor and declare "${key}" in its output schema (manifest \`outputs\` for a custom node, \`expectedOutputs\` for run_command).`
        : isCustomNodeBlockType(predType)
          ? `ACTION REQUIRED: declare "${key}" in the custom node's manifest \`outputs\` (re-register via frink_register_node) so it can be validated.`
          : `ACTION REQUIRED: add "expectedOutputs" to the run_command node's config declaring "${key}" and any other JSON stdout fields so they can be validated.`;
    warnings.push({
      nodeId: node.id,
      field,
      placeholder: `{{${path}}}`,
      message: `{{${path}}} is not a declared output field. Declared: ${available || '(none)'}. This will only resolve if the upstream command prints JSON containing "${key}" to stdout. ${actionHint}`,
    });
    return;
  }

  warnings.push({
    nodeId: node.id,
    field,
    placeholder: `{{${path}}}`,
    message: `{{${path}}} references an unknown output field. Available: ${available || '(none)'}. See the \`frink-flows\` skill (\`SKILL.md\`) for the predecessor block's output schema.`,
  });
}

function checkTriggerPath(
  node: FlowNode,
  field: string,
  path: string,
  segments: string[],
  triggerType: string | undefined,
  triggerFields: TriggerFieldSchema[],
  warnings: TemplateVariableWarning[],
): void {
  const key = segments[1];
  if (!key) return;

  if (!triggerType) {
    // Trigger type unknown (shouldn't happen in valid graphs)
    return;
  }

  if (TRIGGER_ALLOWS_ARBITRARY_KEYS.has(triggerType)) {
    // triggerContext is user-supplied and open-ended for this trigger type —
    // any key is valid at runtime (buildFlowTemplateVariables spreads it wholesale).
    return;
  }

  if (triggerType === 'webhook_trigger') {
    // No provider context here (integrationId → provider needs the cloud API), so we
    // can't resolve which friendly aliases are valid. Accept any known envelope field
    // OR any provider's alias namespace (story/item/email/…) — the editor validates
    // the exact alias with the provider. Still warn on a segment that matches neither
    // (a real typo like trigger.repository).
    const aliasNamespaces = new Set(
      Object.values(TRIGGER_FIELD_ALIASES).flatMap((list) =>
        list.map((a) => a.alias.split('.')[0]),
      ),
    );
    if (triggerFields.some((f) => f.key === key) || aliasNamespaces.has(key)) return;
    const available = triggerFields.map((f) => `trigger.${f.key}`).join(', ');
    warnings.push({
      nodeId: node.id,
      field,
      placeholder: `{{${path}}}`,
      message: `{{${path}}} references an unknown trigger field for webhook_trigger. Available: ${available} (+ provider fields like trigger.story.title — see Available variables).`,
    });
    return;
  }

  if (triggerFields.length === 0) {
    warnings.push({
      nodeId: node.id,
      field,
      placeholder: `{{${path}}}`,
      message: `{{${path}}} references trigger context but ${triggerType} provides no trigger fields. Use {{previous.*}} for upstream node outputs.`,
    });
    return;
  }

  const matched = triggerFields.find((f) => f.key === key);
  if (!matched) {
    const available = triggerFields.map((f) => `trigger.${f.key}`).join(', ');
    warnings.push({
      nodeId: node.id,
      field,
      placeholder: `{{${path}}}`,
      message: `{{${path}}} references an unknown trigger field for ${triggerType}. Available: ${available}.`,
    });
  }
}

function checkLoopPath(
  node: FlowNode,
  field: string,
  path: string,
  segments: string[],
  fanOutBodyMembers: Set<string>,
  warnings: TemplateVariableWarning[],
): void {
  if (!fanOutBodyMembers.has(node.id)) {
    warnings.push({
      nodeId: node.id,
      field,
      placeholder: `{{${path}}}`,
      message: `{{${path}}} references loop context but this node is not inside a fan_out body chain. {{loop.*}} variables are only available within a fan_out body.`,
    });
    return;
  }

  const key = segments[1];
  if (!key) return;

  // currentItem sub-paths are always valid (shape is unknown at design time)
  if (key === 'currentItem') return;

  const validKeys = ['currentIndex', 'totalCount', 'currentItem'];
  if (!validKeys.includes(key)) {
    warnings.push({
      nodeId: node.id,
      field,
      placeholder: `{{${path}}}`,
      message: `{{${path}}} references an unknown loop field. Available loop fields: loop.currentItem (dot notation for sub-fields), loop.currentIndex, loop.totalCount.`,
    });
  }
}
