/**
 * Main-process flow DTO shapes, as the tRPC flow procedures return them
 * (`src/main/lib/flows/adapters.ts` maps Drizzle rows onto these).
 */

import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import type { DbFlowRun } from '../../../shared/types/flow-run';

export type DbFlow = {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
  /** When false, triggers and new runs are blocked; flow is not soft-deleted. */
  is_enabled: boolean;
  /** When true, agents may start runs via MCP with source=agent (server-enforced). */
  agent_invocable: boolean;
  created_at: string;
  updated_at: string;
  /** Number of nodes in the latest saved version; null if no version exists yet (Draft). */
  node_count: number | null;
  /** blockType of the first node in the latest saved version (the trigger type). */
  trigger_type: string | null;
  /** Most recent run for this flow (any version); from list/get detail SQL; omitted on create/PATCH. */
  latest_run_id?: string | null;
  latest_run_status?: string | null;
  /**
   * Active driving-task status of the latest run. The engine parks a run at `paused` on every
   * async agent hand-off, so the dashboard relabels a paused-but-working run via
   * `flowRunDisplayStatus` (same as the Run History panel). Null when no active driving task.
   */
  latest_run_active_task_status?: string | null;
  latest_run_admission_state?: DbFlowRun['admission_state'];
  latest_run_queue_position?: number | null;
  latest_run_admission_requested_at?: string | null;
  /** Latest batch with active runs for this flow; from LATERAL JOIN on list SQL. */
  latest_batch_id?: string | null;
  batch_run_count?: number | null;
  batch_active_count?: number | null;
};

/** Row from GET /flows/:id with latest version joined */
export type DbFlowWithLatestVersion = DbFlow & {
  latest_version_id: string | null;
  version_number: number | null;
  graph: FlowGraph | null;
  version_created_at: string | null;
  /**
   * Active batch ID for this flow, extracted from graph.settings.currentBatchId at SQL time.
   * Only present on GET /flows/:id — NOT on GET /flows (list). Do not add to DbFlow.
   */
  current_batch_id?: string | null;
};

/** Exported: tRPC / declaration emit names return types (TS4023). */
export type DbFlowVersion = {
  id: string;
  flow_id: string;
  version_number: number;
  graph: FlowGraph;
  created_at: string;
};

export type DbBriefingStash = {
  id: string;
  name: string;
  /** Full briefing content. */
  content: string;
  /** Truncated to 120 chars for display. */
  content_preview: string;
  source_flow_id: string | null;
  source_flow_name: string | null;
  created_at: string;
};

/**
 * A flow run row with chat_id joined — only produced by `flows/batch-runs-list.ts`.
 * Do not add chat_id to DbFlowRun itself; it is only available from that query.
 */
export type BatchRunRow = DbFlowRun & { chat_id: string | null };
