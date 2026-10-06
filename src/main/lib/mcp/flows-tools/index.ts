/* eslint-disable max-lines, max-lines-per-function */
/**
 * Frink Flows MCP tools for the dynamic-chat MCP server.
 *
 * Enables agents to mutate and inspect flows programmatically. Static guidance
 * (block types, edge rules, patterns, custom-node manifest) lives in the
 * `frink-flows` Claude skill at `~/.frink/skills/frink-flows/`, not here.
 *
 * Integrated into dynamic-chat-server.ts as a separate tool module.
 *
 * Working tools: frink_flows_patch (create or modify via name/flowId), frink_flows_list, frink_flows_get, frink_flows_run, frink_register_node
 */

import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import { manifestOutputsToSchema } from '../../../../shared/lib/output-schemas';
import { type FlowGraph, validateGraph } from '../../../../shared/lib/validate-flow-graph';
import { refuseIfAwaitingConsent } from './gating/flow-invocation-consent';
import {
  addStageRunsLimiter,
  defineStagesLimiter,
  getBatchLimiter,
  getRunLimiter,
  invalidArgsResult,
  listTemplatesLimiter,
  parseAndAcquire,
  startBatchLimiter,
} from './gating/session-call-limiters';

// Teardown entry points keep their long-standing home on this module.
export {
  resetDefineStagesCount,
  resetFlowsAddStageRunsCount,
  resetFlowsGetBatchCount,
  resetFlowsGetRunCount,
  resetFlowsListTemplatesCount,
  resetListPluginToolsCount,
  resetStartBatchCount,
} from './gating/session-call-limiters';

import {
  computeNodeVariables,
  validateFlowTemplateVariables,
} from '../../../../shared/lib/validate-flow-templates';
import { getCommandContent, listCommands } from '../../commands';
import { discoverCustomNodes } from '../../custom-nodes/discovery';
import { listPluginNodes } from '../../integrations/plugin-node-derivation';
import { getDatabase } from '../../db';
import { getProjectById } from '../../db/repos/projects';
import {
  addStageRuns,
  type BatchRunRow,
  type BatchStageInput,
  createFlow,
  createFlowVersion,
  type DbFlowRun,
  type DbFlowRunWithNodeRuns,
  defineFlowBatchStages,
  deleteFlow,
  getFlow,
  getFlowRun,
  listBatchPlanTemplates,
  listFlowBatchRuns,
  listFlowBatchStages,
  listFlowRuns,
  listFlows,
  sendBatchMessage,
  startFlowBatch,
  startFlowRun,
} from '../../flows/mcp-cloud-shim';
import { type McpToolResult, toolResult } from '../tool-result';
import { handleIntegrationsList, handleNodesList, handleProjectsList } from './catalog';
import { expandAgentCommandsInGraph, formatExpansionFailures } from './expand-commands';
import { applyPatchOperations, patchArgsSchema, seedDefaultProject } from './flow-patch';
import {
  buildFlowPatchReceipt,
  buildFlowPatchResult,
  buildFlowPatchUnexpectedError,
  flowPatchError,
  rollbackCreatedFlow,
  rollbackCreatedFlowUnlessPersisted,
} from './flow-patch-result';
import { buildFlowRunLaunchResult } from './flow-run-launch-result';
import { mapFlowRunToSummary } from './map-flow-run';
import { handleRegisterNode, REGISTER_NODE_TOOL, type RegisterNodeOptions } from './register-node';
import { resolveCreationProject } from './resolve-creation-project';
import { describeFlowRunBlockers } from './run-readiness';
import { truncateNodeOutput } from './truncate-node-output';

export { resetRegisterNodeCount } from './register-node';

// ---------------------------------------------------------------------------
// Argument schemas (Zod)
// ---------------------------------------------------------------------------

/** The mcp-cloud-shim throws TRPCError NOT_FOUND for missing flows/runs/stages. */
function isTrpcNotFound(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'NOT_FOUND';
}

const listArgsSchema = z.object({
  projectId: z.string().optional(),
});

/**
 * Resolve a projectId to its absolute local path for command scanning.
 * Returns null for unknown projects or virtual (folder) projects with no real path.
 */
async function resolveProjectPath(projectId: string): Promise<string | null> {
  const row = await getProjectById(getDatabase(), projectId);
  if (!row?.path || row.path.startsWith('virtual://')) return null;
  return row.path;
}

/**
 * Local flow entity IDs (flows, runs, node-runs) are cuid2 short IDs, not UUIDs.
 * Validate non-empty rather than UUID format. `batchId` is the exception — it is the
 * randomUUID-minted graph.settings.currentBatchId and keeps `.uuid()`.
 */
const localIdField = (name: string) =>
  z.string().trim().min(1, `${name} must be a non-empty string`);

const commandsListArgsSchema = z.object({
  flowId: localIdField('flowId').optional(),
});

const getArgsSchema = z.object({
  flowId: localIdField('flowId'),
});

const runArgsSchema = z.object({
  flowId: localIdField('flowId'),
  triggerContext: z.record(z.string(), z.unknown()).optional(),
});

export const GET_RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const GET_RUN_MAX_TIMEOUT_MS = 300_000;
export const GET_RUN_MIN_TIMEOUT_MS = 5_000;
export const GET_RUN_INITIAL_POLL_MS = 2_000;
export const GET_RUN_MAX_POLL_MS = 15_000;
export const GET_RUN_POLL_BACKOFF = 1.5;

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

const EARLY_RETURN_STATUSES = new Set(['paused', 'awaiting_input']);

const getRunArgsSchema = z.object({
  runId: localIdField('runId'),
  nodeRunId: localIdField('nodeRunId').optional(),
  wait: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const VALID_BATCH_RUN_STATUSES = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

const listRunsArgsSchema = z.object({
  flowId: localIdField('flowId'),
  limit: z.number().int().min(1).max(50).optional(),
});

const getBatchArgsSchema = z.object({
  flowId: localIdField('flowId'),
  batchId: z.string().uuid('batchId must be a valid UUID'),
  status: z.enum(VALID_BATCH_RUN_STATUSES).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const batchMessageArgsSchema = z.object({
  flowId: localIdField('flowId'),
  batchId: z.string().uuid('batchId must be a valid UUID'),
  message: z
    .string()
    .min(1, 'message must not be empty')
    .max(10000, 'message must be 10000 characters or fewer'),
  flowRunId: localIdField('flowRunId').optional(),
});

const batchStageRunSchema = z.object({
  triggerContext: z.record(z.string(), z.unknown()).optional(),
});

const batchStageSchema = z.object({
  stageNumber: z.number().int().min(1, 'stageNumber must be >= 1'),
  name: z.string().optional(),
  failureThreshold: z.number().int().min(-1).optional(),
  dependsOn: z
    .array(z.number().int().min(1, 'dependsOn entries must be positive stage numbers'))
    .optional(),
  runs: z
    .array(batchStageRunSchema)
    .min(1, 'each stage must have at least one run')
    // Mirrors the add_stage_runs per-call cap. Without a ceiling here a single
    // stage could stage unbounded work, which the start_batch consent card has
    // to quote back to the user.
    .max(50, 'max 50 runs per stage per call — add more with frink_flows_add_stage_runs'),
});

const defineStagesArgsSchema = z.object({
  flowId: localIdField('flowId'),
  batchId: z.string().uuid('batchId must be a valid UUID'),
  stages: z
    .array(batchStageSchema)
    .min(1, 'stages must contain at least one stage')
    .max(50, 'max 50 stages'),
});

const listStagesArgsSchema = z.object({
  flowId: localIdField('flowId'),
  batchId: z.string().uuid('batchId must be a valid UUID'),
});

// ---------------------------------------------------------------------------
// Rate limiting: max flow runs per execution session
// ---------------------------------------------------------------------------

const MAX_RUN_PER_SESSION = 5;
const GLOBAL_RUN_SESSION_KEY = '__global_run__';
const runSuccessCounts = new Map<string, number>();
const runInFlightBySession = new Map<string, number>();

function tryAcquireRunSlot(sessionKey: string): boolean {
  const successes = runSuccessCounts.get(sessionKey) ?? 0;
  const inFlight = runInFlightBySession.get(sessionKey) ?? 0;
  if (successes + inFlight >= MAX_RUN_PER_SESSION) {
    return false;
  }
  runInFlightBySession.set(sessionKey, inFlight + 1);
  return true;
}

function releaseRunInFlight(sessionKey: string): void {
  const n = runInFlightBySession.get(sessionKey) ?? 0;
  const next = Math.max(0, n - 1);
  if (next === 0) {
    runInFlightBySession.delete(sessionKey);
  } else {
    runInFlightBySession.set(sessionKey, next);
  }
}

function recordRunSuccess(sessionKey: string): void {
  runSuccessCounts.set(sessionKey, (runSuccessCounts.get(sessionKey) ?? 0) + 1);
}

/** Clear per-session flow run rate limits (call from clearCurrentExecutionChat). */
export function resetFlowsRunCount(executionId?: string): void {
  if (executionId === undefined) {
    runSuccessCounts.clear();
    runInFlightBySession.clear();
    return;
  }
  runSuccessCounts.delete(executionId);
  runInFlightBySession.delete(executionId);
}

// ---------------------------------------------------------------------------
// Rate limiting: max successful frink_flows_patch per execution session
// ---------------------------------------------------------------------------

const MAX_PATCH_PER_SESSION = 15;
const GLOBAL_PATCH_SESSION_KEY = '__global_patch__';
const patchSuccessCounts = new Map<string, number>();
const patchInFlightBySession = new Map<string, number>();

function tryAcquirePatchSlot(sessionKey: string): boolean {
  const successes = patchSuccessCounts.get(sessionKey) ?? 0;
  const inFlight = patchInFlightBySession.get(sessionKey) ?? 0;
  if (successes + inFlight >= MAX_PATCH_PER_SESSION) {
    return false;
  }
  patchInFlightBySession.set(sessionKey, inFlight + 1);
  return true;
}

function releasePatchInFlight(sessionKey: string): void {
  const n = patchInFlightBySession.get(sessionKey) ?? 0;
  const next = Math.max(0, n - 1);
  if (next === 0) {
    patchInFlightBySession.delete(sessionKey);
  } else {
    patchInFlightBySession.set(sessionKey, next);
  }
}

function recordPatchSuccess(sessionKey: string): void {
  patchSuccessCounts.set(sessionKey, (patchSuccessCounts.get(sessionKey) ?? 0) + 1);
}

/** Clear per-session flow patch rate limits (call from clearCurrentExecutionChat with run resets). */
export function resetFlowsPatchCount(executionId?: string): void {
  if (executionId === undefined) {
    patchSuccessCounts.clear();
    patchInFlightBySession.clear();
    return;
  }
  patchSuccessCounts.delete(executionId);
  patchInFlightBySession.delete(executionId);
}

// ---------------------------------------------------------------------------
// Rate limiting: max frink_flows_get_run calls per execution session
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rate limiting: max frink_flows_get_batch calls per execution session.
// The merged frink_flows_get_batch tool covers the former list_runs / get_batch
// / list_stages reads, so this single counter is bumped to 40 (vs the old 20)
// to keep monitoring loops from starving.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rate limiting: max frink_flows_list_templates calls per execution session
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rate limiting: max frink_flows_add_stage_runs calls per execution session
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rate limiting: max frink_flows_start_batch calls per execution session
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rate limiting: max frink_flows_define_stages calls per execution session
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rate limiting: patch creation sub-limit (name-based calls = new flow creates)
// ---------------------------------------------------------------------------

const MAX_PATCH_CREATE_PER_SESSION = 5;
const patchCreateCounts = new Map<string, number>();

function tryAcquirePatchCreateSlot(sessionKey: string): boolean {
  const count = patchCreateCounts.get(sessionKey) ?? 0;
  if (count >= MAX_PATCH_CREATE_PER_SESSION) return false;
  patchCreateCounts.set(sessionKey, count + 1);
  return true;
}

/** Give back a create slot when an auto-created flow is rolled back (never saved). */
function releasePatchCreateSlot(sessionKey: string): void {
  const count = patchCreateCounts.get(sessionKey) ?? 0;
  if (count <= 1) patchCreateCounts.delete(sessionKey);
  else patchCreateCounts.set(sessionKey, count - 1);
}

export function resetFlowsPatchCreateCount(executionId?: string): void {
  if (executionId === undefined) {
    patchCreateCounts.clear();
    return;
  }
  patchCreateCounts.delete(executionId);
}

// ---------------------------------------------------------------------------
// Shared JSON Schema fragment reused in multiple tool inputSchema definitions
// ---------------------------------------------------------------------------

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
const PATCH_OPERATIONS_INPUT_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  description:
    'Ordered list of patch operations (max 50). Ops: update_node (nodeId, optional label/config/position/parentId — config merges recursively; null removes keys), add_node (node), remove_node (nodeId, removes contained Fan Out nodes and incident edges), add_edge (edge), remove_edge (edgeId), update_edge (edgeId + label and/or sourceHandle), update_settings (partial flow settings).',
  items: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: [
          'update_node',
          'add_node',
          'remove_node',
          'add_edge',
          'remove_edge',
          'update_edge',
          'update_settings',
        ],
      },
      nodeId: { type: 'string' },
      parentId: {
        type: ['string', 'null'],
        description: 'Fan Out owner id; null removes ownership.',
      },
      edgeId: { type: 'string' },
      label: { type: 'string' },
      config: { type: 'object' },
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
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

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const FLOWS_TOOLS = [
  {
    name: 'frink_flows_patch',
    description:
      'Create a new flow or modify an existing one using incremental operations. To CREATE: pass name + operations (creates the flow and applies ops to an empty graph). To MODIFY: pass flowId + operations. The graph is saved after each call even with incomplete configs — stricter run-mode validation (URLs, webhooks, agent instructions, etc.) runs when you start the flow and when the server creates batch stages (frink_flows_define_stages), not on every patch. Config on update_node is merged recursively (RFC 7396 / JSON Merge Patch): send only changed keys; set a key to null to remove it. Do not pass blockType on update_node (use remove_node + add_node to change type). Max 50 operations per call; max 5 flow creates and 15 modifications per chat session. Template warnings and per-node available variables are included in every response. A visual flow preview is rendered in chat when successful — do not redraw Mermaid or list all nodes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        flowId: {
          type: 'string',
          description:
            'UUID of an existing flow to modify. Get from frink_flows_list or frink_flows_get. Provide this OR name, not both.',
        },
        name: {
          type: 'string',
          description:
            'Display name for a new flow to create. Provide this OR flowId, not both. When set, a new flow is created and operations are applied to an empty graph.',
        },
        description: {
          type: 'string',
          description: 'Optional description for the new flow (only used when creating with name).',
        },
        projectId: {
          type: 'string',
          description:
            'Optional project id for the new flow (only used when creating with name). Also seeds the flow\'s default project (settings.defaultProjectId), which start_task/run_command nodes inherit. When omitted, defaults to the current session\'s project when resolvable (the response states the outcome); discover ids with frink_flows_list_catalog({ kind: "projects" }).',
        },
        operations: PATCH_OPERATIONS_INPUT_SCHEMA,
      },
      required: ['operations'],
    },
  },
  {
    name: 'frink_flows_list',
    description:
      'List existing Frink Flows. Optional projectId narrows to flows assigned to that project plus workspace-wide flows (no project). Omit projectId to list all flows for the user.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: {
          type: 'string',
          description:
            'Optional project UUID. Returns flows tied to this project and flows with no project (null project_id). Omit for every flow.',
        },
      },
    },
  },
  {
    name: 'frink_flows_get',
    description: 'Get the graph and config of an existing Frink Flow by ID.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        flowId: {
          type: 'string',
          description: 'Flow UUID',
        },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'frink_flows_run',
    description:
      'Start or queue a flow run using the latest published graph version. A successful response status is "started" or "queued" and includes queuePosition when queued; a run cancelled or failed before starting returns a "not_started" error. Agent runs need the flow\'s "Allow agents to run this flow" grant (agent_invocable). If it is off, just call this anyway from a chat: Frink raises a consent card asking the user to allow this run once, allow the flow from now on, or deny — you do NOT need them to open Flow settings. A "permissionDenied" response means they declined; do not retry, ask them in chat instead. Requirements: flow must be enabled; max 5 successful submissions per chat session (failures do not count). Optional triggerContext is passed as-is to the flow trigger — shape depends on trigger type (e.g. manual_trigger). Monitor progress in the Flows page Run history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        flowId: {
          type: 'string',
          description: 'UUID of the flow to run',
        },
        triggerContext: {
          type: 'object',
          description:
            'Optional JSON object forwarded to the flow run trigger_context. Omit for default manual trigger behavior.',
        },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'frink_flows_get_run',
    description:
      "Inspect a flow run: get status, per-node outcomes, errors, and durations. Call this after frink_flows_run to check results or debug failures. Pass wait: true to block until the run finishes (polls internally with backoff, default 120s timeout) — preferred over manual poll loops. Returns a compact summary; pass nodeRunId to drill into a specific node's output. Fan-out lanes are aggregated. Rate limit: 20 calls per chat session.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        runId: {
          type: 'string',
          description:
            'UUID of the flow run to inspect. Use the flowRunId returned by frink_flows_run.',
        },
        nodeRunId: {
          type: 'string',
          description:
            'Optional. When provided, includes the full node_output for this specific node run in nodeDetail. Use a nodeRunId from the nodes array. Outputs are truncated to 8KB max.',
        },
        wait: {
          type: 'boolean',
          description:
            'When true, blocks until the run reaches a terminal state (completed/failed/cancelled) or timeout. Polls internally with exponential backoff — no need for manual sleep/poll loops. Returns early for paused/awaiting_input runs. Default: false.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Max wait time in ms when wait=true. Default: 120000 (2 min), max: 300000 (5 min). Ignored when wait is false.',
        },
      },
      required: ['runId'],
    },
  },
  REGISTER_NODE_TOOL,
  {
    name: 'frink_flows_get_batch',
    description:
      'Inspect batch/run execution state for a flow. Three modes: (1) omit batchId — list the flow’s recent runs (status, batch_id, timing); (2) pass batchId — batch summary with completed/failed/active counts + per-run status (optional status filter); (3) pass batchId with include:["stages"] — the staged-batch stage breakdown (per-stage run counts + dependencies), for monitoring frink_flows_define_stages. Rate limit: 40 calls per chat session.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        flowId: {
          type: 'string',
          description: 'UUID of the flow. Required for all modes.',
        },
        batchId: {
          type: 'string',
          description:
            'Optional. Omit to list the flow’s recent runs. Provide to inspect a specific batch. Available from frink_flows_run (batchId), a run’s batch_id, or graph.settings.currentBatchId.',
        },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['runs', 'stages'] },
          description:
            'Optional, only meaningful with batchId. Include "stages" to return the staged-batch stage breakdown instead of the run list. Ignored without batchId.',
        },
        status: {
          type: 'string',
          description:
            'Optional filter (batch mode): only return runs with this status. One of: pending, running, paused, completed, failed, cancelled.',
        },
        limit: {
          type: 'number',
          description:
            'Max number of runs to return. Default: 20 (max 50 in list-runs mode, 100 in batch mode).',
        },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'frink_batch_message',
    description:
      'Send a message from the CEO agent to employee agents in a batch. Use for broadcasting corrections, follow-up instructions, or targeted guidance to a specific run. Broadcast: omit flowRunId. Targeted: provide flowRunId. Active runs queue the message for delivery on completion; terminal runs are marked delivered immediately.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        flowId: {
          type: 'string',
          description: 'UUID of the flow the batch belongs to.',
        },
        batchId: {
          type: 'string',
          description: 'UUID of the batch to message.',
        },
        message: {
          type: 'string',
          description: 'The instruction or message to send. Max 10000 characters.',
        },
        flowRunId: {
          type: 'string',
          description:
            'Optional. UUID of a specific run to target. Omit to broadcast to all runs in the batch.',
        },
      },
      required: ['flowId', 'batchId', 'message'],
    },
  },
  {
    name: 'frink_flows_define_stages',
    description:
      'Define staged execution for a batch, with optional DAG dependencies between stages. All stages start as pending — call frink_flows_start_batch after planning is complete to begin execution. This allows multi-call DAG assembly (up to 50 stages per call) for large epics without starting work prematurely. The server validates the flow graph in run mode before creating stages. Non-root stages fire automatically when all their dependencies complete after the batch is started. Omit dependsOn for linear execution. Use dependsOn: [stageNumber, ...] for arbitrary dependency graphs. failureThreshold: 0 = any failure blocks dependent stages; -1 = never block. A call that returns an error saved nothing from that call — fix the input and re-send the same stages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        flowId: {
          type: 'string',
          description: 'UUID of the flow.',
        },
        batchId: {
          type: 'string',
          description: 'UUID of the batch to define stages for.',
        },
        stages: {
          type: 'array',
          description:
            'List of stages (1-based stageNumber). Max 50. Cross-call dependsOn references (stage numbers from a previous define_stages call) are supported — the server merges existing stages for validation.',
          items: {
            type: 'object',
            properties: {
              stageNumber: { type: 'number', description: '1-based stage number.' },
              name: { type: 'string', description: 'Optional stage name (e.g. "Planning").' },
              failureThreshold: {
                type: 'number',
                description:
                  'Max failures allowed before blocking dependent stages. Default: 0. Use -1 to never block.',
              },
              dependsOn: {
                type: 'array',
                items: { type: 'number' },
                description:
                  'Stage numbers this stage depends on. Omit for linear execution (auto-chained by stageNumber order). Provide [] or omit to make this a root stage.',
              },
              runs: {
                type: 'array',
                description:
                  'Runs for this stage when it becomes runnable. All stages are created pending; nothing executes until frink_flows_start_batch. Dependencies are validated in run mode. After the batch starts, root stages run first; non-root stages start automatically once their dependencies complete.',
                items: {
                  type: 'object',
                  properties: {
                    triggerContext: {
                      type: 'object',
                      description:
                        'Optional per-run data injected as {{trigger.*}} variables in the flow. Common keys: label (display name shown in Monitor), workstreamId (groups stage by workstream, e.g. "auth-module"), customInstructions (per-run agent override). The server may best-effort merge new keys into the flow\'s batchTriggerSchema (non-blocking; only for supported trigger types such as manual_trigger; failures do not affect this call) so they can appear as typed chips — do not assume every key (e.g. label, workstreamId, customInstructions) is always added; use frink_flows_patch update_settings batchTriggerSchema to declare explicitly. Do NOT set baseBranch here — it is resolved at dispatch time from the completed dependency stage outputs and injected automatically.',
                    },
                  },
                },
              },
            },
            required: ['stageNumber', 'runs'],
          },
        },
      },
      required: ['flowId', 'batchId', 'stages'],
    },
  },
  {
    name: 'frink_flows_add_stage_runs',
    description:
      'Add runs to an existing stage incrementally (max 50 per call, max 20 calls per session). Use this after frink_flows_define_stages to add more runs to any stage (root or non-root) before calling frink_flows_start_batch. All stages remain pending until start_batch is called — runs added here are also pending. Per-run errors are reported without aborting the whole call. For epic-scale work (e.g. 144 tickets): define_stages in batches of 50, add_stage_runs for more runs, then start_batch once.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        flowId: {
          type: 'string',
          description: 'UUID of the flow.',
        },
        batchId: {
          type: 'string',
          description: 'UUID of the batch.',
        },
        stageNumber: {
          type: 'number',
          description: '1-based stage number to add runs to.',
        },
        runs: {
          type: 'array',
          description: 'Runs to add to this stage (max 50 per call).',
          items: {
            type: 'object',
            properties: {
              triggerContext: {
                type: 'object',
                description:
                  'Optional per-run data injected as {{trigger.*}} variables. Common keys: label (Monitor display name), workstreamId (visual grouping), customInstructions (per-run agent override). Same best-effort, non-blocking batchTriggerSchema merge as frink_flows_define_stages (supported trigger types only; not guaranteed for every key) — use update_settings batchTriggerSchema to declare explicitly.',
              },
            },
          },
        },
      },
      required: ['flowId', 'batchId', 'stageNumber', 'runs'],
    },
  },
  {
    name: 'frink_flows_start_batch',
    description:
      'Activate a planned batch. Call this after frink_flows_define_stages (and any frink_flows_add_stage_runs calls). Root stages transition from pending to running and stage runs are submitted to Flow admission up to the per-stage dispatch limit; admitted runs may still wait in the global queue. A true started value means at least one root stage was activated, not that a run began executing; totalEnqueued counts runs submitted during this call. Non-root stages activate automatically as dependencies complete; a stage defined after its dependencies already completed is activated by the next start_batch call (or cancelled if a dependency failed). Idempotent: returns { started: false, reason, totalStages, rootStageCount, startedRootCount } when no pending roots remain — reason is one of: no-stages-defined, no-root-stages, all-roots-started, unknown (e.g. race). Rate limit: 5 calls per session. Like frink_flows_run, this needs the flow\'s "Allow agents to run this flow" grant (agent_invocable) because it executes the flow — if it is off, calling this from a chat raises a consent card stating how many runs the batch will start; the user can allow this batch once, allow the flow from now on, or deny. Note that adding runs to an already-running stage widens a batch the user already approved without asking again.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        flowId: {
          type: 'string',
          description: 'UUID of the flow.',
        },
        batchId: {
          type: 'string',
          description: 'UUID of the batch to start.',
        },
      },
      required: ['flowId', 'batchId'],
    },
  },
  {
    name: 'frink_flows_list_catalog',
    description:
      'List a reference catalog for building flows. kind selects which: "integrations" — the user’s connected integrations (id, provider, account, event types) for a webhook_trigger node (set trigger integrationId + eventType from the result); "commands" — slash-commands (saved prompts) referenceable from an agent node by setting its instructions to "/<name>" as the first token (frink_flows_patch expands it on save); "templates" — saved batch-plan DAG templates (stage names + dependency edges) to seed frink_flows_define_stages; "projects" — the user’s projects (id, name, path): use the id as projectId for flow creation, flow settings defaultProjectId, or start_task config; "nodes" — the custom and plugin node types INSTALLED on this machine (blockType, config inputs, outputs) for a custom-node flow node, plus pluginId to list the live tools behind a connected plugin’s <pluginId>_call_tool node and search to narrow them. Pass flowId to scope commands to the flow’s project / order templates by source flow (ignored for integrations, projects and nodes).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          enum: ['integrations', 'commands', 'templates', 'projects', 'nodes'],
          description: 'Which catalog to list.',
        },
        flowId: {
          type: 'string',
          description:
            'Optional flow UUID. Scopes commands to the flow’s project (plus user-global) and orders templates from this flow first. Ignored for integrations, projects and nodes.',
        },
        pluginId: {
          type: 'string',
          description:
            'Optional, kind "nodes" only: replace the installed-node list with the LIVE tools behind that plugin’s <pluginId>_call_tool node. Ignored by the other kinds.',
        },
        search: {
          type: 'string',
          description:
            'Optional, with pluginId: narrow that tool list (matches tool name and title, falling back to descriptions). An exact tool name additionally returns that tool’s argument schema. Ignored by the other kinds.',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
] as const;

export const FLOWS_TOOL_NAMES: ReadonlySet<string> = new Set(FLOWS_TOOLS.map((tool) => tool.name));

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * frink_flows_get_batch (merged read): one rate-limit slot, three modes.
 * No batchId → list the flow's recent runs; batchId → batch summary; batchId +
 * include:['stages'] → staged-batch stage breakdown. Absorbs the former
 * frink_flows_list_runs + frink_flows_get_batch + frink_flows_list_stages — the
 * leaf handlers keep their own arg parsing/fetch; this only acquires the slot
 * once and routes on the discriminator.
 */
async function handleGetBatchDispatch(
  args: Record<string, unknown>,
  executionId?: string,
): Promise<McpToolResult> {
  const sessionKey = executionId ?? getBatchLimiter.globalKey;
  if (!getBatchLimiter.tryAcquire(sessionKey)) {
    return toolResult(
      `Rate limit reached: frink_flows_get_batch allows ${getBatchLimiter.max} calls per chat session.`,
      true,
    );
  }

  // Route on the raw discriminator only — a malformed `include` (or a present-but-
  // non-string batchId) must not discard a valid batchId and silently fall back to
  // the run list. The leaf handlers do the strict UUID/enum validation.
  const hasBatchId = args.batchId !== undefined && args.batchId !== null && args.batchId !== '';
  const include = Array.isArray(args.include) ? args.include : [];

  if (!hasBatchId) return handleListRuns(args);
  if (include.includes('stages')) return handleListStages(args);
  return handleGetBatch(args);
}

const listCatalogSchema = z.object({
  kind: z.enum(['integrations', 'commands', 'templates', 'projects', 'nodes']),
  flowId: z.string().optional(),
  pluginId: z.string().optional(),
  search: z.string().optional(),
});

/**
 * frink_flows_list_catalog (merged read): routes by `kind` to the former
 * frink_integrations_list / frink_commands_list / frink_flows_list_templates.
 * Only the templates branch is rate-limited (parity with prior behavior).
 */
async function handleListCatalog(
  args: Record<string, unknown>,
  executionId?: string,
): Promise<McpToolResult> {
  const parsed = listCatalogSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);
  switch (parsed.data.kind) {
    case 'integrations':
      return handleIntegrationsList();
    case 'commands':
      return handleCommandsList(args);
    case 'templates':
      return handleListTemplates(args, executionId);
    case 'projects':
      return handleProjectsList();
    case 'nodes':
      return handleNodesList(parsed.data.pluginId, parsed.data.search, executionId);
  }
}

/**
 * Per-call outcome of the flow-invocation consent gate (`gateFlowInvocation`).
 *
 * `invocationConsented` is a ONE-CALL grant: the user approved this specific
 * invocation without turning on the flow's standing `agent_invocable` right.
 * It is passed as an argument rather than held in module state so it can never
 * outlive the call or leak across turns.
 */
export type FlowInvocationOptions = {
  invocationConsented?: boolean;
};

/** Per-call context the dispatcher threads to the handler that needs it. */
export type FlowToolCallOptions = FlowInvocationOptions & {
  /** Required by frink_register_node: the authorization callback for its captured snapshot. */
  registerNode?: RegisterNodeOptions;
};

export async function handleFlowsToolCall(
  toolName: string,
  args: Record<string, unknown>,
  executionId?: string,
  sessionProjectPath?: string,
  options?: FlowToolCallOptions,
): Promise<McpToolResult | null> {
  switch (toolName) {
    case 'frink_flows_patch':
      return handlePatch(args, executionId, sessionProjectPath);
    case 'frink_flows_list':
      return handleList(args);
    case 'frink_flows_get':
      return handleGet(args);
    case 'frink_flows_run':
      return handleRun(args, executionId, options);
    case 'frink_flows_get_run':
      return handleGetRun(args, executionId);

    case 'frink_register_node':
      if (!options?.registerNode) {
        return toolResult('Registration authorization context is required.', true);
      }
      return handleRegisterNode(args, executionId, sessionProjectPath, options.registerNode);

    case 'frink_flows_get_batch':
      return handleGetBatchDispatch(args, executionId);

    case 'frink_batch_message':
      return handleBatchMessage(args);

    case 'frink_flows_define_stages':
      return handleDefineStages(args, executionId);

    case 'frink_flows_add_stage_runs':
      return handleAddStageRuns(args, executionId);

    case 'frink_flows_start_batch':
      return handleStartBatch(args, executionId, options);

    case 'frink_flows_list_catalog':
      return handleListCatalog(args, executionId);

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Patch-time setup hints for webhook triggers left without a real integration binding (a
 * webhook_trigger fires only when config.integrationId + config.eventType are set). */
function collectWebhookSetupHints(graph: FlowGraph): string[] {
  const hints: string[] = [];
  for (const node of graph.nodes) {
    if (node.blockType !== 'webhook_trigger') continue;
    const config = (node.config ?? {}) as Record<string, unknown>;
    const iid = typeof config.integrationId === 'string' ? config.integrationId.trim() : '';
    const et = typeof config.eventType === 'string' ? config.eventType.trim() : '';
    if (iid && et) continue;
    hints.push(
      `Webhook trigger "${node.label ?? node.id}" needs integrationId + eventType — call frink_flows_list_catalog({ kind: 'integrations' }) to get valid values.`,
    );
  }
  return hints;
}

async function handlePatch(
  args: Record<string, unknown>,
  executionId?: string,
  sessionProjectPath?: string,
): Promise<McpToolResult> {
  const parsed = patchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return flowPatchError(
      `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      'none',
    );
  }

  const { flowId: existingFlowId, name, description, projectId, operations } = parsed.data;
  const sessionKey = executionId ?? GLOBAL_PATCH_SESSION_KEY;

  if (!tryAcquirePatchSlot(sessionKey)) {
    return flowPatchError(
      `Rate limit reached: max ${MAX_PATCH_PER_SESSION} successful flow patches per session. Start a new chat to patch more flows.`,
      'none',
    );
  }

  let createdFlowId: string | null = null;
  let creationProjectNote: string | null = null;
  let persistenceAttempted = false;
  let persistenceCompleted = false;

  try {
    let flowId: string;
    let baseGraph: FlowGraph;
    let flowName: string;
    let expectedVersionNumber: number;
    let flowProjectId: string | undefined;

    if (name !== undefined) {
      // Creating a new flow -- check creation sub-limit first
      if (!tryAcquirePatchCreateSlot(sessionKey)) {
        return flowPatchError(
          `Rate limit reached: max ${MAX_PATCH_CREATE_PER_SESSION} flow creations per session. Use flowId to modify existing flows, or start a new chat.`,
          'none',
        );
      }

      const resolution = await resolveCreationProject({
        explicitProjectId: projectId,
        sessionProjectPath,
      });
      creationProjectNote =
        resolution.outcome === 'session-default'
          ? `Created in project "${resolution.projectName}" (defaulted from the current session; pass projectId to override).`
          : resolution.outcome === 'none'
            ? 'Created without a project — set one in flow settings or pass projectId.'
            : null;

      const flow = await createFlow({
        name,
        description: description ?? null,
        projectId: resolution.projectId,
      });
      createdFlowId = flow.id;
      flowId = flow.id;
      flowName = flow.name;
      flowProjectId = resolution.projectId ?? undefined;
      // Seed the runtime default project into the initial graph; it is version-pinned on
      // save, so creation is the only moment the DB project can flow into the graph.
      baseGraph = seedDefaultProject({ nodes: [], edges: [] }, resolution.projectId);
      expectedVersionNumber = 0;
    } else {
      // Modifying an existing flow
      // existingFlowId is guaranteed non-null here by the Zod .refine() that requires
      // either flowId or name (not both, not neither).
      flowId = existingFlowId ?? '';
      let existing: Awaited<ReturnType<typeof getFlow>>;
      try {
        existing = await getFlow(flowId);
      } catch (err) {
        if (isTrpcNotFound(err)) {
          return flowPatchError(
            `Flow not found (id: ${flowId}). Use frink_flows_list to find existing flows.`,
            'none',
          );
        }
        throw err;
      }
      flowName = existing.name;
      flowProjectId = existing.project_id ?? undefined;
      // If the flow has no graph yet, start from empty (allows patching a newly created
      // flow) — seeded with the flow's project as the runtime default, like creation.
      baseGraph = existing.graph ?? seedDefaultProject({ nodes: [], edges: [] }, flowProjectId);
      expectedVersionNumber = existing.version_number ?? 0;
    }

    const applied = applyPatchOperations(baseGraph, operations);

    switch (applied.status) {
      case 'failure': {
        // Rollback auto-created flow on failure
        const rollback = await rollbackCreatedFlow({
          flowId: createdFlowId,
          context: 'patch auto-create',
          deleteFlow,
          releaseCreateSlot: () => releasePatchCreateSlot(sessionKey),
        });
        createdFlowId = null;
        return flowPatchError(
          applied.error,
          rollback.confirmed ? 'none' : undefined,
          rollback.recoveryFlowId,
        );
      }
      case 'success':
      case 'partial': {
        if (applied.status === 'partial') {
          log.warn(
            `[flows-tools] patch partial: ${applied.applied.length}/${operations.length} ops on flow ${flowId}`,
          );
        }

        // Expand leading `/command` in agent instructions into its saved-prompt
        // body before persisting (parity with the UI dropdown). Unknown commands
        // hard-fail so a broken flow is never saved. Only nodes whose instructions
        // were set in THIS patch are (re)expanded — a previously-expanded body that
        // happens to begin with a `/word` must not be re-scanned on an unrelated
        // patch (that would hard-fail and leave the flow un-patchable).
        const expandTargets = new Set<string>();
        for (const op of operations) {
          if (op.op === 'update_node' && typeof op.config?.instructions === 'string') {
            expandTargets.add(op.nodeId);
          } else if (
            op.op === 'add_node' &&
            typeof (op.node.config as { instructions?: unknown } | undefined)?.instructions ===
              'string'
          ) {
            expandTargets.add(op.node.id);
          }
        }

        const expansion = await expandAgentCommandsInGraph(applied.graph, {
          resolveProjectPath,
          listCommands,
          getContent: getCommandContent,
          fallbackProjectId: flowProjectId,
          targetNodeIds: expandTargets,
        });
        if (!expansion.ok) {
          const rollback = await rollbackCreatedFlow({
            flowId: createdFlowId,
            context: 'command-expansion',
            deleteFlow,
            releaseCreateSlot: () => releasePatchCreateSlot(sessionKey),
          });
          createdFlowId = null;
          return flowPatchError(
            formatExpansionFailures(expansion.failures),
            rollback.confirmed ? 'none' : undefined,
            rollback.recoveryFlowId,
          );
        }

        // Plugin nodes are derived, never in `valid`; reading only `valid` broke {{previous.*}} (sc-2508).
        const { valid } = discoverCustomNodes();
        const customNodeOutputs = new Map(
          [...valid, ...listPluginNodes()].map((m) => [m.name, manifestOutputsToSchema(m.outputs)]),
        );
        const nodeVariables = computeNodeVariables(applied.graph, { customNodeOutputs });
        const patchTemplateWarnings = validateFlowTemplateVariables(applied.graph, nodeVariables);
        const webhookSetup = collectWebhookSetupHints(applied.graph);

        persistenceAttempted = true;
        const version = await createFlowVersion(flowId, {
          graph: applied.graph,
          expectedVersionNumber,
        });
        persistenceCompleted = true;
        const receipt = buildFlowPatchReceipt({
          mode: name !== undefined ? 'create' : 'update',
          baseGraph,
          finalGraph: applied.graph,
          operations,
          applied: applied.applied,
          failed: applied.failed,
          skipped: applied.skipped,
          baseVersionNumber: expectedVersionNumber,
          persistedVersionNumber: version.version_number,
        });

        recordPatchSuccess(sessionKey);

        return buildFlowPatchResult({
          patch: applied,
          receipt,
          flowId,
          versionId: version.id,
          name: flowName,
          operationCount: operations.length,
          creationProjectNote,
          createdFlow: Boolean(createdFlowId),
          templateWarnings: patchTemplateWarnings,
          webhookSetup,
        });
      }
    }
  } catch (err) {
    const hadCreatedFlow = Boolean(createdFlowId);
    const rollback = await rollbackCreatedFlowUnlessPersisted({
      flowId: createdFlowId,
      context: 'patch auto-create',
      deleteFlow,
      releaseCreateSlot: () => releasePatchCreateSlot(sessionKey),
      persistenceCompleted,
    });
    createdFlowId = null;
    return buildFlowPatchUnexpectedError({
      error: err,
      hadCreatedFlow,
      rollback,
      persistenceAttempted,
    });
  } finally {
    releasePatchInFlight(sessionKey);
  }
}

async function handleCommandsList(args: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = commandsListArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { flowId } = parsed.data;
  let projectPath: string | undefined;
  if (flowId) {
    try {
      const flow = await getFlow(flowId);
      const settingsPid = (flow.graph as { settings?: { defaultProjectId?: unknown } } | null)
        ?.settings?.defaultProjectId;
      const projectId =
        flow.project_id ?? (typeof settingsPid === 'string' ? settingsPid : undefined);
      if (projectId) {
        projectPath = (await resolveProjectPath(projectId)) ?? undefined;
      }
    } catch (err) {
      log.warn('[flows-tools] frink_commands_list: flow lookup failed, listing user-global:', err);
    }
  }

  const commands = await listCommands(projectPath);
  return toolResult(
    JSON.stringify(
      {
        count: commands.length,
        projectScoped: projectPath !== undefined,
        commands: commands.map((c) => ({
          name: c.name,
          description: c.description,
          origin: c.origin,
          source: c.source,
        })),
        message:
          commands.length === 0
            ? 'No commands found. Define commands in .frink/.cursor/.claude/commands/*.md (project or ~ home).'
            : 'Reference a command from an agent node by setting its instructions to "/<name>" (first token). It expands to the saved prompt body when the flow is saved.',
      },
      null,
      2,
    ),
  );
}

async function handleList(args: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = listArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { projectId } = parsed.data;
  try {
    const flows = await listFlows(projectId);

    if (flows.length === 0) {
      return toolResult(JSON.stringify({ flows: [], message: 'No flows found.' }, null, 2));
    }

    return toolResult(
      JSON.stringify(
        {
          flows: flows.map((f) => ({
            id: f.id,
            name: f.name,
            description: f.description,
            is_enabled: f.is_enabled,
            agent_invocable: f.agent_invocable,
            trigger_type: f.trigger_type,
            node_count: f.node_count,
            created_at: f.created_at,
          })),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to list flows: ${message}`, true);
  }
}


async function handleGet(args: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = getArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { flowId } = parsed.data;
  try {
    const flow = await getFlow(flowId);

    return toolResult(
      JSON.stringify(
        {
          id: flow.id,
          name: flow.name,
          description: flow.description,
          project_id: flow.project_id,
          is_enabled: flow.is_enabled,
          agent_invocable: flow.agent_invocable,
          trigger_type: flow.trigger_type,
          node_count: flow.node_count,
          latest_version_id: flow.latest_version_id,
          version_number: flow.version_number,
          graph: flow.graph,
          created_at: flow.created_at,
          updated_at: flow.updated_at,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to get flow: ${message}`, true);
  }
}

/**
 * Load a flow and apply the terminal agent-run check in one step.
 *
 * Returns a tool result when the caller should stop (flow missing, or no
 * standing grant and no consent for this call), otherwise the flow.
 */
async function loadFlowForInvocation(
  flowId: string,
  invocation: FlowInvocationOptions | undefined,
): Promise<{ flow: Awaited<ReturnType<typeof getFlow>> } | { refusal: McpToolResult }> {
  let flow: Awaited<ReturnType<typeof getFlow>>;
  try {
    flow = await getFlow(flowId);
  } catch (err) {
    if (isTrpcNotFound(err)) {
      return {
        refusal: toolResult(
          `Flow not found (id: ${flowId}). Use frink_flows_list to find existing flows.`,
          true,
        ),
      };
    }
    throw err;
  }
  if (flow.agent_invocable || invocation?.invocationConsented) return { flow };
  return {
    refusal: toolResult(
      'This flow does not allow agent runs yet. Frink asks the user to approve it in chat when a run is requested from an active chat; from this caller there is no chat to ask in, so the user must turn on "Allow agents to run this flow" in Flow settings.',
      true,
    ),
  };
}

async function handleRun(
  args: Record<string, unknown>,
  executionId?: string,
  invocation?: FlowInvocationOptions,
): Promise<McpToolResult> {
  const parsed = runArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const sessionKey = executionId ?? GLOBAL_RUN_SESSION_KEY;
  if (!tryAcquireRunSlot(sessionKey)) {
    return toolResult(
      `Rate limit reached: max ${MAX_RUN_PER_SESSION} flow runs per session. Start a new chat to run more flows.`,
      true,
    );
  }

  try {
    const { flowId, triggerContext } = parsed.data;

    const loaded = await loadFlowForInvocation(flowId, invocation);
    if ('refusal' in loaded) return loaded.refusal;
    const { flow } = loaded;

    if (!flow.is_enabled) {
      return toolResult('Flow is disabled.', true);
    }

    if (flow.graph === null) {
      return toolResult(
        `Flow "${flow.name}" has no saved graph version. Build the flow with frink_flows_patch first.`,
        true,
      );
    }
    const blockers = describeFlowRunBlockers(flow.graph);
    if (blockers !== null) {
      return toolResult(
        `Flow "${flow.name}" is not ready to run. Fix the following before starting: ${blockers}`,
        true,
      );
    }

    const run = (await startFlowRun(flowId, {
      triggerContext: triggerContext ?? null,
    })) as DbFlowRun & { flowRunId?: string; batchId?: string | null };

    const launchResult = buildFlowRunLaunchResult(flowId, run);
    if (!launchResult.isError) recordRunSuccess(sessionKey);
    return toolResult(JSON.stringify(launchResult.body, null, 2), launchResult.isError);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // loadStartDefinition (flows/start.ts) can throw NOT_FOUND on a flow deleted
    // between the loadFlowForInvocation check above and this dispatch.
    if (isTrpcNotFound(err)) {
      return toolResult(
        `${message || 'Not found'}. If the flow has no published version yet, save the graph in the Flow editor first.`,
        true,
      );
    }
    return toolResult(`Failed to start flow run: ${message}`, true);
  } finally {
    releaseRunInFlight(sessionKey);
  }
}

async function fetchFlowRun(runId: string): Promise<DbFlowRunWithNodeRuns> {
  return getFlowRun(runId);
}

function clampTimeout(raw: number | undefined): number {
  if (raw === undefined) return GET_RUN_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(raw, GET_RUN_MIN_TIMEOUT_MS), GET_RUN_MAX_TIMEOUT_MS);
}

function isRunDone(status: string): 'terminal' | 'early' | false {
  if (TERMINAL_RUN_STATUSES.has(status)) return 'terminal';
  if (EARLY_RETURN_STATUSES.has(status)) return 'early';
  return false;
}

async function pollUntilDone(
  runId: string,
  timeoutMs: number,
  fetchFn: (id: string) => Promise<DbFlowRunWithNodeRuns> = fetchFlowRun,
): Promise<{ run: DbFlowRunWithNodeRuns; timedOut: boolean; earlyReturn: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let pollDelay = GET_RUN_INITIAL_POLL_MS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const run = await fetchFn(runId);
    const done = isRunDone(run.status);
    if (done === 'terminal') return { run, timedOut: false, earlyReturn: false };
    if (done === 'early') return { run, timedOut: false, earlyReturn: true };
    if (Date.now() + pollDelay >= deadline) return { run, timedOut: true, earlyReturn: false };

    await new Promise<void>((r) => setTimeout(r, pollDelay));
    pollDelay = Math.min(Math.floor(pollDelay * GET_RUN_POLL_BACKOFF), GET_RUN_MAX_POLL_MS);
  }
}

function buildGetRunResponse(
  run: DbFlowRunWithNodeRuns,
  nodeRunId: string | undefined,
  extra: Record<string, unknown> = {},
): McpToolResult {
  const summary = mapFlowRunToSummary(run);

  if (nodeRunId !== undefined) {
    const nodeRun = run.nodeRuns.find((nr) => nr.id === nodeRunId);
    if (!nodeRun) {
      return toolResult(
        JSON.stringify(
          {
            ...summary,
            ...extra,
            nodeDetail: {
              error: `Node run not found: ${nodeRunId}. Check the nodeRunId from the nodes array in a previous get_run call.`,
            },
          },
          null,
          2,
        ),
      );
    }

    const rawOutputs = nodeRun.node_output?.outputs as Record<string, unknown> | undefined;
    if (!rawOutputs) {
      return toolResult(
        JSON.stringify(
          {
            ...summary,
            ...extra,
            nodeDetail: {
              nodeRunId: nodeRun.id,
              status: nodeRun.status,
              outputs: null,
              truncated: false,
              fullSizeBytes: 0,
              message: 'Node has no output recorded yet (not started or output is null)',
            },
          },
          null,
          2,
        ),
      );
    }

    const { outputs, truncated, fullSizeBytes } = truncateNodeOutput(rawOutputs);
    return toolResult(
      JSON.stringify(
        {
          ...summary,
          ...extra,
          nodeDetail: { nodeRunId: nodeRun.id, outputs, truncated, fullSizeBytes },
        },
        null,
        2,
      ),
    );
  }

  return toolResult(JSON.stringify({ ...summary, ...extra, nodeDetail: null }, null, 2));
}

async function handleGetRun(
  args: Record<string, unknown>,
  executionId?: string,
): Promise<McpToolResult> {
  const parsed = getRunArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { runId, nodeRunId, wait, timeoutMs: rawTimeout } = parsed.data;
  const sessionKey = executionId ?? getRunLimiter.globalKey;

  if (!getRunLimiter.tryAcquire(sessionKey)) {
    return toolResult(
      `Rate limit reached: frink_flows_get_run allows ${getRunLimiter.max} calls per chat session. ` +
        'Use wait: true to avoid manual polling, or check the Flows page.',
      true,
    );
  }

  let run: DbFlowRunWithNodeRuns;
  try {
    run = await fetchFlowRun(runId);
  } catch (err) {
    if (isTrpcNotFound(err)) {
      return toolResult(
        `Flow run not found: ${runId}. Check that the runId is correct — use the flowRunId returned by frink_flows_run.`,
        true,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to fetch flow run: ${message}`, true);
  }

  if (wait && !isRunDone(run.status)) {
    const timeout = clampTimeout(rawTimeout);
    try {
      const result = await pollUntilDone(runId, timeout);
      run = result.run;
      const waitMeta: Record<string, unknown> = { waited: true };
      if (result.timedOut) waitMeta.waitTimedOut = true;
      if (result.earlyReturn) {
        waitMeta.earlyReturn = true;
        waitMeta.earlyReturnReason = `Run status is '${run.status}' — requires human action. Not polling further.`;
      }
      return buildGetRunResponse(run, nodeRunId, waitMeta);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolResult(`Polling failed while waiting for run: ${message}`, true);
    }
  }

  return buildGetRunResponse(run, nodeRunId);
}

// ---------------------------------------------------------------------------
// Handler: frink_flows_list_runs
// ---------------------------------------------------------------------------

async function handleListRuns(args: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = listRunsArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { flowId, limit = 20 } = parsed.data;

  let runs: DbFlowRun[];
  try {
    // listFlowRuns is a plain DB read — it returns [] for an unknown flowId, never throws.
    runs = await listFlowRuns(flowId, limit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to list flow runs: ${message}`, true);
  }

  const data = {
    flowId,
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      batch_id: r.batch_id ?? null,
      started_at: r.started_at,
      completed_at: r.completed_at,
      created_at: r.created_at,
    })),
    count: runs.length,
  };

  return toolResult(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Handler: frink_flows_get_batch
// ---------------------------------------------------------------------------

async function handleGetBatch(args: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = getBatchArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { flowId, batchId, status, limit = 20 } = parsed.data;

  let runs: BatchRunRow[];
  let total: number;
  try {
    // listFlowBatchRuns is a plain DB read — an unknown batchId yields an empty result, never a throw.
    const result = await listFlowBatchRuns(flowId, batchId, { status, limit });
    runs = result.runs;
    total = result.total;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to fetch batch: ${message}`, true);
  }

  const statusCounts = runs.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const data = {
    flowId,
    batchId,
    total,
    completed: statusCounts.completed ?? 0,
    failed: (statusCounts.failed ?? 0) + (statusCounts.cancelled ?? 0),
    active: (statusCounts.running ?? 0) + (statusCounts.paused ?? 0) + (statusCounts.pending ?? 0),
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      chat_id: r.chat_id ?? null,
      started_at: r.started_at,
      completed_at: r.completed_at,
      created_at: r.created_at,
    })),
  };

  return toolResult(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Handler: frink_batch_message
// ---------------------------------------------------------------------------

async function handleBatchMessage(args: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = batchMessageArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { flowId, batchId, message, flowRunId } = parsed.data;

  try {
    const result = await sendBatchMessage(flowId, batchId, message, flowRunId);
    return toolResult(
      JSON.stringify(
        {
          success: result.success,
          queued: result.queued,
          delivered: result.delivered,
          message: result.message,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    // sendBatchMessage's local impl always throws NOT_IMPLEMENTED — never NOT_FOUND.
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to send batch message: ${msg}`, true);
  }
}

// ---------------------------------------------------------------------------
// Handler: frink_flows_define_stages
// ---------------------------------------------------------------------------

async function handleDefineStages(
  args: Record<string, unknown>,
  executionId?: string,
): Promise<McpToolResult> {
  const parsed = defineStagesArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { flowId, batchId, stages } = parsed.data;

  // Before the quota: a call refused only because its batch is frozen did no
  // work, so burning a slot for it would let repeated refusals dead-end the
  // session while the user is still deciding.
  const frozen = refuseIfAwaitingConsent(batchId);
  if (frozen) return frozen;

  const sessionKey = executionId ?? defineStagesLimiter.globalKey;
  if (!defineStagesLimiter.tryAcquire(sessionKey)) {
    return toolResult(
      `Rate limit reached: max ${defineStagesLimiter.max} define_stages calls per session. Start a new chat if you need to stage more work.`,
      true,
    );
  }

  try {
    const result = await defineFlowBatchStages(flowId, batchId, stages as BatchStageInput[]);

    const stageSummary = result.stages.map((s) => ({
      stageNumber: s.stageNumber,
      name: s.name,
      status: s.status,
      runCount: s.runCount,
      dependsOnStageNumbers: s.dependsOnStageNumbers,
    }));

    return toolResult(
      JSON.stringify(
        {
          success: true,
          stageCount: result.stages.length,
          rootStageCount: result.rootStageCount,
          maxDepth: result.maxDepth,
          stages: stageSummary,
          message: `${result.stages.length} stage(s) defined. All stages, including ${result.rootStageCount} root stage(s), are pending until frink_flows_start_batch — execution begins only after that call. Dependencies are validated in run mode; after the batch starts, non-root stages automatically start once their dependencies complete.`,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to define batch stages: ${msg}`, true);
  }
}

// ---------------------------------------------------------------------------
// Handler: frink_flows_list_stages
// ---------------------------------------------------------------------------

async function handleListStages(args: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = listStagesArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { flowId, batchId } = parsed.data;

  try {
    const result = await listFlowBatchStages(flowId, batchId);
    return toolResult(
      JSON.stringify(
        {
          flowId,
          batchId,
          stageCount: result.stages.length,
          stages: result.stages.map((s) => ({
            stageNumber: Number(s.stage_number),
            name: s.name,
            status: s.status,
            failureThreshold: Number(s.failure_threshold),
            dependsOnStageNumbers: s.depends_on_stage_numbers ?? [],
            runCount: Number(s.run_count),
            completed: Number(s.completed_count),
            failed: Number(s.failed_count),
            active: Number(s.active_count),
          })),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    // listFlowBatchStages is a plain DB read — an unknown batchId yields [], never a throw.
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to list batch stages: ${msg}`, true);
  }
}

// ---------------------------------------------------------------------------
// Handler: frink_flows_list_templates
// ---------------------------------------------------------------------------

const listTemplatesArgsSchema = z.object({
  flowId: localIdField('flowId').optional(),
});

async function handleListTemplates(
  args: Record<string, unknown>,
  executionId?: string,
): Promise<McpToolResult> {
  const { data, refusal } = parseAndAcquire(
    listTemplatesArgsSchema,
    args,
    executionId,
    listTemplatesLimiter,
    `Rate limit reached: frink_flows_list_catalog({ kind: "templates" }) allows ${listTemplatesLimiter.max} calls per chat session.`,
  );
  if (refusal) return refusal;

  try {
    const templates = await listBatchPlanTemplates(data.flowId);
    return toolResult(
      JSON.stringify(
        {
          templateCount: templates.length,
          templates: templates.map((t) => ({
            id: t.id,
            name: t.name,
            schemaVersion: t.schema_version,
            sourceFlowId: t.source_flow_id,
            stageCount: t.stages.length,
            stages: t.stages.map((s) => ({
              stageNumber: s.stageNumber,
              name: s.name,
              dependsOn: s.dependsOn,
            })),
            createdAt: t.created_at,
          })),
          usage:
            'To use a template: copy the stages array, add a runs array to each stage with triggerContext per run, then call frink_flows_define_stages.',
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to list templates: ${msg}`, true);
  }
}

const addStageRunsArgsSchema = z.object({
  flowId: localIdField('flowId'),
  batchId: z.string().uuid('batchId must be a valid UUID'),
  stageNumber: z.number().int().min(1, 'stageNumber must be >= 1'),
  runs: z
    .array(
      z.object({
        triggerContext: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1, 'runs must contain at least one run')
    .max(50, 'runs must contain at most 50 runs per call'),
});

async function handleAddStageRuns(
  args: Record<string, unknown>,
  executionId?: string,
): Promise<McpToolResult> {
  const sessionKey = executionId ?? addStageRunsLimiter.globalKey;
  const parsed = addStageRunsArgsSchema.safeParse(args);
  if (!parsed.success) return invalidArgsResult(parsed.error);

  const { flowId, batchId, stageNumber, runs } = parsed.data;

  // Before the quota, for the same reason as define_stages: a refusal that did
  // no work must not spend a slot.
  const frozen = refuseIfAwaitingConsent(batchId);
  if (frozen) return frozen;

  if (!addStageRunsLimiter.tryAcquire(sessionKey)) {
    return toolResult(
      `Rate limit reached: max ${addStageRunsLimiter.max} add_stage_runs calls per session. Start a new chat to add more runs.`,
      true,
    );
  }

  try {
    const result = await addStageRuns(flowId, stageNumber, batchId, runs);
    return toolResult(
      JSON.stringify(
        {
          success: true,
          flowId,
          batchId,
          stageNumber,
          added: result.added.length,
          failed: result.failed.length,
          addedRuns: result.added,
          ...(result.failed.length > 0 ? { failedRuns: result.failed } : {}),
          message: `Added ${result.added.length} run(s) to stage ${stageNumber}${result.failed.length > 0 ? `. ${result.failed.length} run(s) failed — see failedRuns for details.` : '.'}`,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    if (isTrpcNotFound(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      return toolResult(`Batch or flow not found — cannot add stage runs. ${detail}`, true);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to add stage runs: ${msg}`, true);
  }
}

const startBatchArgsSchema = z.object({
  flowId: localIdField('flowId'),
  batchId: z.string().uuid('batchId must be a valid UUID'),
});

/** Why a start_batch call activated nothing, in the agent's own terms. */
function describeUnstartedBatch(reason: string | undefined): string {
  switch (reason) {
    case 'no-stages-defined':
      return 'No batch stages are defined yet — call frink_flows_define_stages first.';
    case 'no-root-stages':
      return 'This batch has stages but no root stages (all stages have dependencies).';
    case 'all-roots-started':
      return 'All root stages have already left pending; their submitted runs may still be queued or running.';
    default:
      return 'No pending root stages to start (see reason and counts).';
  }
}

async function handleStartBatch(
  args: Record<string, unknown>,
  executionId?: string,
  invocation?: FlowInvocationOptions,
): Promise<McpToolResult> {
  const { data, refusal } = parseAndAcquire(
    startBatchArgsSchema,
    args,
    executionId,
    startBatchLimiter,
    `Rate limit reached: max ${startBatchLimiter.max} start_batch calls per session. Start a new chat if you need to retry.`,
  );
  if (refusal) return refusal;

  const { flowId, batchId } = data;

  try {
    // Batch dispatch executes the same flow as frink_flows_run, many times over
    // a DAG, so it needs the same consent. This is the only agent-initiated DAG
    // entry: define_stages/add_stage_runs insert `pending` rows and never
    // dispatch, and every downstream dispatch is a successor of a stage started
    // here. Gating dispatchPendingStageRun instead would fire once per stage-run
    // from a run-terminal event with no chat context to prompt in.
    const loaded = await loadFlowForInvocation(flowId, invocation);
    if ('refusal' in loaded) return loaded.refusal;

    const result = await startFlowBatch(flowId, batchId);
    if (!result.started) {
      return toolResult(
        JSON.stringify(
          {
            success: true,
            started: false,
            reason: result.reason ?? 'unknown',
            totalStages: result.totalStages,
            rootStageCount: result.rootStageCount,
            startedRootCount: result.startedRootCount,
            startedStageNumbers: result.startedStageNumbers ?? [],
            totalEnqueued: result.totalEnqueued ?? 0,
            message: describeUnstartedBatch(result.reason),
          },
          null,
          2,
        ),
      );
    }
    return toolResult(
      JSON.stringify(
        {
          success: true,
          started: true,
          startedStageNumbers: result.startedStageNumbers ?? [],
          totalEnqueued: result.totalEnqueued ?? 0,
          message: `Batch root stage(s) activated. ${result.totalEnqueued ?? 0} run(s) submitted to Flow admission from stage(s): [${(result.startedStageNumbers ?? []).join(', ')}].`,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    // resolveBatchCtx (flows/batch-context.ts) can throw NOT_FOUND on a flow deleted
    // between the loadFlowForInvocation check above and this dispatch.
    if (isTrpcNotFound(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      return toolResult(`Batch or flow not found — cannot start batch. ${detail}`, true);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to start batch: ${msg}`, true);
  }
}
