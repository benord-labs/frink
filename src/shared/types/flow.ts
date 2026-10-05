/**
 * Shared Frink Flows runtime contract.
 *
 * These definitions are mirrored between:
 * - `src/shared/types/flow.ts`
 * so serverless handlers do not depend on Electron/client module paths.
 * Sync is enforced by `flow.sync.test.ts`.
 */

import type { TaskSignalState } from './task-signal';

// --- Block types (canonical list in ../lib/block-registry.ts) ---
export { FLOW_BLOCK_TYPES, type FlowBlockType } from '../lib/block-registry';

// --- Node output envelope (from scoped spec section 3.1) ---
const NODE_STATUSES = [
  'completed',
  'failed',
  'blocked',
  'awaiting_input',
  'cancelled',
  'skipped',
] as const;

type NodeStatus = (typeof NODE_STATUSES)[number];

type NodeArtifact = {
  type: 'log' | 'diff' | 'test_result' | 'summary' | 'link' | 'other';
  uri: string;
  label?: string;
  meta?: Record<string, unknown>;
};

type NodeError = {
  message: string;
  code?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type NodeOutput = {
  status: NodeStatus;
  outputs: Record<string, unknown>;
  artifacts: NodeArtifact[];
  error?: NodeError;
  durationMs: number;
  signal?: TaskSignalState;
  /** This awaiting_input came from the user's own Pause, not an agent park. */
  userPaused?: boolean;
};

// --- Run states (from scoped spec section 3.3) ---
const FLOW_RUN_STATUSES = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

/**
 * Run states in which no task of the run can still accept an agent signal, so the executor disarms
 * the whole task-signal apparatus (lifecycle prompt, stop hook, `frink_task_signal`) for that chat.
 *
 * Deliberately NOT `failed` or `paused`: a follow-up message un-parks both in place, so the agent's
 * next signal must still land. Disarming them would kill recovery for every failed or paused flow.
 *
 * Distinct from `getActiveFlowRunForSubChat`'s live set (`pending|running|paused`), which answers a
 * different question — which run owns the chat composer — and treats `failed` as dead.
 */
export const SIGNAL_DEAD_RUN_STATUSES = ['completed', 'cancelled'] as const;

/**
 * Non-terminal `tasks.status` values where a flow task is still driving its chat (excludes
 * done/completed/failed/cancelled; `plan_ready` stays so the chat plan card is suppressed while
 * paused). `awaiting_input`/`blocked` are node-run statuses, never here.
 *
 * Lives beside `SIGNAL_DEAD_RUN_STATUSES` rather than in `db/repos/tasks.ts` so the shared SQL
 * fragment that pairs them imports both without a cycle back through the repo barrel.
 */
export const FLOW_DRIVING_STATUSES = [
  'pending',
  'running',
  'plan_ready',
  'needs_attention',
] as const;

/** Node run statuses that can be acted on (retry/skip) when a flow is paused on failure. */
export const RESUME_ACTIONABLE_NODE_STATUSES = ['failed', 'awaiting_input', 'blocked'] as const;

/**
 * Terminal node_run status for an attempt a user Retry replaced: the retry inserts a fresh row
 * (attempt + 1) and this one stays as history. Readers deriving a node's CURRENT state skip it.
 */
export const SUPERSEDED_NODE_STATUS = 'superseded';

/**
 * Stamped on the interrupted node's output (and the linked task's result) by the boot recovery
 * sweep when the app/process restarts mid-flow. The run goes `cancelled` (neutral — a restart is
 * not a flow error); this marker is the discriminator the run panel keys "Re-run from previous
 * node" on, separating a restart interruption from a user-initiated cancel (e.g. a deleted chat,
 * whose worktree/chat may be gone). See docs/decisions/flow-run-cancel-on-chat-removal.md.
 */
export const RESTART_INTERRUPTION_REASON = 'Interrupted by app restart';

// --- Condition block ---
export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'truthy',
  'falsy',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Condition node output result value when predicate evaluates to true (continue branch). */
export const CONDITION_TRUE_RESULT = 'continue' as const;

/** Predicate stored in flow graph JSON; `value` omitted for truthy/falsy operators. */
export type ConditionPredicate = {
  field: string;
  operator: ConditionOperator;
  value?: unknown;
};

// --- Flow-level settings (persisted in flow_versions.graph.settings) ---
export type { FlowSettings } from './flow-settings-schema';
export { flowSettingsSchema } from './flow-settings-schema';

// --- Block config shapes (editor + runtime dispatch contract) ---

/** Working directory for a run_command node. */
export type RunCommandWorkingDir = 'project_root' | 'trigger_worktree' | 'custom';

export type RunCommandBlockConfig = {
  command: string;
  projectId: string;
  /** Working directory mode. Defaults to 'project_root'. */
  workingDirectory?: RunCommandWorkingDir;
  /** Custom path used when workingDirectory is 'custom'. */
  customPath?: string;
  /**
   * Declared JSON output fields this command will produce on stdout.
   * When set, these fields appear as chips in the Available Variables panel for downstream nodes
   * and are validated by the template variable checker.
   * Same shape as custom node manifest `outputs`. `exitCode` is always present regardless.
   */
  expectedOutputs?: Record<string, { type: string; description?: string }>;
};

export type HttpRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ConditionLoopConfig = {
  /** Max re-runs of the loop body (1–50). Default: 10. */
  maxIterations: number;
  /** What to do when maxIterations is reached. Default: 'fail'. */
  onMaxReached: 'fail' | 'continue';
};

/** post_task_trigger node config (execution uses flow_trigger_bindings + this for UX defaults). */
export type { PostTaskTriggerState } from './flows/flow-trigger-binding-config';

// --- Flow execution events (socket: flow:execution-event) ---

type FlowExecutionEventType =
  | 'run_started'
  | 'run_paused'
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_skipped'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled'
  | 'batch_completed';

/** Emitted by the Railway engine to the user's Socket.io room at key execution transitions. */
export type FlowExecutionEvent = {
  eventType: FlowExecutionEventType;
  flowId: string;
  /** Absent on batch_completed — a batch has no single run. */
  flowRunId?: string;
  flowName: string;
  runStatus: string;
  /**
   * Present on batch_completed and stamped on batch-MEMBER run events so the
   * renderer can keep members individually silent (only the batch sounds).
   */
  batchId?: string;
  /**
   * run_paused only — names a wait that is NOT about the user. 'user' = their own Pause click;
   * 'agent-handoff' = the engine waiting on a dispatched agent task (fires on every node advance).
   * Absent = the run is waiting on YOU, the only pause worth announcing.
   */
  pauseKind?: 'user' | 'agent-handoff';
  /** Node-level fields — present for node_* events (Phase 2 canvas watcher) */
  nodeId?: string;
  blockType?: string;
  nodeLabel?: string;
  loopIteration?: number;
  /** Total number of iterations/lanes in the fan-out — present on node_started events inside fan-out bodies. */
  loopTotalCount?: number;
  /** Graph node ID of the parent fan_out node — present on body node events so the renderer can update the fan_out chip. */
  fanOutNodeId?: string;
  /** Run-level summary fields — present for run_completed / run_failed / run_cancelled */
  durationMs?: number;
  summary?: string;
  nodeStatuses?: Record<string, { status: string; durationMs?: number }>;
};

/**
 * One batch stage run row as listed in the BatchMonitor (snake_case end-to-end per
 * the flows IPC casing contract). The start_task fields are read from the run's
 * latest start_task node_run on the LOCAL read path only — absent on cloud rows,
 * so consumers must treat them as optional. A converging-merge conflict parks the
 * start_task at `awaiting_input` while batch_stage_runs.status stays `dispatched`;
 * those fields let the UI surface that parked state.
 */
export type BatchStageRunRow = {
  id: string;
  stage_id: string;
  status: string;
  trigger_context: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  chat_id: string | null;
  /** The run is waiting on a person (a parked node with no live task) — decided server-side. */
  needs_input: boolean;
  start_task_status?: string;
  merge_conflict?: boolean;
  conflicting_branch?: string;
  conflicted_files?: string[];
  merged_branches?: string[];
};
