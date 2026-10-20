import { PATCH_OPS } from '../flow-patch';

const POSITION_INPUT_SCHEMA = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
} as const;

const NODE_SIZE_INPUT_SCHEMA = {
  type: 'object',
  description:
    'Fan Out only: canvas container size; grows the container past what fits its members.',
  properties: { width: { type: 'number' }, height: { type: 'number' } },
} as const;

const GRAPH_INPUT_SCHEMA = {
  type: 'object',
  description:
    'Flow graph with nodes and edges. Each node needs id, blockType, and optional config. Each edge needs id, source, target.',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          blockType: { type: 'string' },
          parentId: {
            type: 'string',
            description: 'Fan Out node id when this node belongs to its per-item body.',
          },
          label: { type: 'string' },
          config: { type: 'object' },
          position: POSITION_INPUT_SCHEMA,
          size: NODE_SIZE_INPUT_SCHEMA,
        },
        required: ['id', 'blockType'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          target: { type: 'string' },
          sourceHandle: { type: 'string', enum: ['true', 'false'] },
          label: { type: 'string' },
        },
        required: ['id', 'source', 'target'],
      },
    },
  },
  required: ['nodes', 'edges'],
} as const;

/** MCP JSON Schema hint for patch operations (Zod is authoritative in handler). */
export const PATCH_OPERATIONS_INPUT_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  description:
    'Ordered list of patch operations (max 50). Ops: update_node (nodeId, optional label/config/position/parentId/size — config merges recursively; null removes keys; size is Fan Out only and null clears it), add_node (node), remove_node (nodeId, removes contained Fan Out nodes and incident edges), add_edge (edge), remove_edge (edgeId), update_edge (edgeId + label and/or sourceHandle), update_settings (partial flow settings), auto_layout (no fields; once per patch; resets every node to the default top-to-bottom layout after the other ops, discarding manual positions and Fan Out sizes). When positions or Fan Out sizes change or nodes collide the result carries `layout` (bounds, overlaps, upwardEdges).',
  items: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: PATCH_OPS,
      },
      nodeId: { type: 'string' },
      parentId: {
        type: ['string', 'null'],
        description: 'Fan Out owner id; null removes ownership.',
      },
      edgeId: { type: 'string' },
      label: { type: 'string' },
      config: { type: 'object' },
      position: POSITION_INPUT_SCHEMA,
      size: {
        ...NODE_SIZE_INPUT_SCHEMA,
        type: ['object', 'null'],
        description: `${NODE_SIZE_INPUT_SCHEMA.description} null clears it.`,
      },
      node: GRAPH_INPUT_SCHEMA.properties.nodes.items,
      edge: GRAPH_INPUT_SCHEMA.properties.edges.items,
      sourceHandle: { type: 'string', enum: ['true', 'false'] },
      settings: {
        type: 'object',
        description:
          'Flow-level settings for update_settings op. Supports: defaultModel (string), defaultProjectId (UUID string), briefing (string, max 10000 chars — shared PRD/spec delivered once per session as a system prompt to every agent in the flow; do not reference it in instructions; set to "" to clear), pauseOnFailure (boolean — when true, flow pauses instead of terminating on node failure, allowing retry or skip from run history), maxBatchConcurrency (number 1–20 — per-stage concurrent BSR ceiling; defaults to the built-in dispatch ceiling of 5 and can only cap below that ceiling), batchTriggerSchema (array — declare expected {{trigger.*}} variables for manual_trigger batch flows so they appear as typed chips in the editor; each item: { key: string (valid JS identifier, max 64 chars), type: "string"|"number"|"boolean"|"object"|"array", description?: string, example?: string }; max 100 entries; merging keys from triggerContext at run time is best-effort, non-blocking, and only for supported trigger types — not guaranteed for every key).',
        properties: {
          defaultModel: { type: 'string' },
          defaultProjectId: { type: 'string' },
          briefing: {
            type: 'string',
            description:
              'Shared context (PRD, spec, checklist) delivered once per flow session as a system prompt to every agent in the flow — never repeated in each agent\'s message, and not referenced in instructions. Rendered against {{trigger.*}} only. Max 10,000 chars. Set to "" to clear.',
          },
          pauseOnFailure: {
            type: 'boolean',
            description:
              'When true, the flow pauses instead of terminating when a node fails. The failed node can then be retried or skipped from the run history UI. State is preserved in Postgres indefinitely. Defaults to false (terminate on failure).',
          },
          maxBatchConcurrency: {
            type: 'number',
            description:
              'Per-stage concurrent batch-run dispatch ceiling (integer 1–20). Defaults to the built-in ceiling of 5. Values above 5 are clamped to 5; lower values cap how many runs from a stage are submitted at once.',
          },
          batchTriggerSchema: {
            type: 'array',
            maxItems: 100,
            description:
              'Declare expected {{trigger.*}} variables for manual_trigger batch flows. Each declared variable shows as a typed chip in the Available Variables panel. The server may best-effort merge keys seen in triggerContext from frink_flows_define_stages or frink_flows_add_stage_runs into this array (non-blocking; failures ignored; only flows using supported trigger types such as manual_trigger) — do not rely on merge alone or assume every key (e.g. label, workstreamId, customInstructions) is added; set this field explicitly for design-time declarations and types/descriptions. Max 100 entries.',
            items: {
              type: 'object',
              properties: {
                key: {
                  type: 'string',
                  maxLength: 64,
                  pattern: '^[a-zA-Z_]\\w*$',
                  description:
                    'Variable name — must be a valid JS identifier (/^[a-zA-Z_]\\w*$/, max 64 chars). Used as {{trigger.<key>}} in agent instructions.',
                },
                type: {
                  type: 'string',
                  enum: ['string', 'number', 'boolean', 'object', 'array'],
                  description: 'Value type for display in the Available Variables panel.',
                },
                description: {
                  type: 'string',
                  maxLength: 200,
                  description: 'Optional description (max 200 chars).',
                },
                example: {
                  type: 'string',
                  maxLength: 200,
                  description: 'Optional example value (max 200 chars).',
                },
              },
              required: ['key', 'type'],
            },
          },
        },
      },
    },
    required: ['op'],
  },
} as const;
