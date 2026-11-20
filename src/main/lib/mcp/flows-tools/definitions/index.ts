import { PATCH_OPERATIONS_INPUT_SCHEMA } from '../patch';
import { REGISTER_NODE_TOOL } from '../register-node/tool-definition';

/** The Flows tools' listing, kept apart from their handlers so naming them loads no Flows runtime. */
export const FLOWS_TOOLS = [
  {
    name: 'frink_flows_patch',
    description:
      'Create a new flow or modify an existing one using incremental operations. To CREATE: pass name + operations (creates the flow and applies ops to an empty graph). To MODIFY: pass flowId + operations. The graph is saved after each call even with incomplete configs — stricter run-mode validation (URLs, webhooks, agent instructions, etc.) runs when you start the flow and when the server creates batch stages (frink_flows_define_stages), not on every patch. Config on update_node is merged recursively (RFC 7396 / JSON Merge Patch): send only changed keys; set a key to null to remove it. When modifying, pass expectedVersionNumber (version_number from frink_flows_get, then the versionNumber each patch returns) so a save another session made in between is never overwritten. Do not pass blockType on update_node (use remove_node + add_node to change type). Max 50 operations per call; max 5 flow creates and 15 modifications per chat session. Template warnings and a topology-only graph (node ids, labels, block types, edges) are included in every response; call frink_flows_get for full node config. If a result is missing, cut short, or replaced by a note such as "saved to <path>", the call may have finished: check with frink_flows_get (or frink_flows_list after a create) before retrying, and never resend a create — a repeated name-create in the same chat is rejected. A visual flow preview is rendered in chat when successful — do not redraw Mermaid or list all nodes.',
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
        expectedVersionNumber: {
          type: ['integer', 'null'],
          description:
            'Version your edits are based on: version_number from frink_flows_get, or the versionNumber your last patch returned. When the flow has moved past it, nothing is saved and the result has errorCode FLOW_VERSION_CONFLICT with the current version and what changed; re-read the flow and re-apply your edits. Only with flowId.',
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
      'Inspect batch/run execution state for a flow. Three modes: (1) omit batchId — list the flow’s recent runs (status, batch_id, timing); (2) pass batchId — batch summary with completed/failed/active counts + per-run status (optional status filter). The counts and batch_total always cover every run in the batch, whatever limit and status are; total is the number of runs matching the status filter, and runs is one page of them; (3) pass batchId with include:["stages"] — the staged-batch stage breakdown (per-stage run counts + dependencies), for monitoring frink_flows_define_stages. Rate limit: 40 calls per chat session.',
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
