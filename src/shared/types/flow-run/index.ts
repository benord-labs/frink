import type { FlowAdmissionState } from '../../lib/flow-admission';
import type { FlowGraph } from '../../lib/validate-flow-graph';
import type { NodeOutput } from '../flow';

export type DbFlowRun = {
  id: string;
  flow_version_id: string;
  status: string;
  /** Active Flow-driving task status used to render paused runs truthfully. */
  active_task_status?: string | null;
  admission_state?: FlowAdmissionState | null;
  queue_position?: number | null;
  admission_requested_at?: string | null;
  trigger_context: Record<string, unknown> | null;
  idempotency_key: string | null;
  batch_id?: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export type DbNodeRun = {
  id: string;
  flow_run_id: string;
  node_id: string;
  block_type: string;
  status: string;
  node_output: Partial<NodeOutput> | null;
  attempt_number: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  /** Parallel fan-out lanes; null for the main graph row (`SELECT *` from `node_runs`). */
  lane_index: number | null;
  parent_fan_out_node_run_id: string | null;
};

export type DbFlowRunWithNodeRuns = DbFlowRun & {
  nodeRuns: DbNodeRun[];
  /** Version snapshot for this run; the run's `flow_versions.graph`. */
  graph: FlowGraph | null;
};
