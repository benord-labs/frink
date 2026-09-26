/** Batch-level DTOs shared between the flows router and the batch monitor / report surfaces. */

export type BatchSummary = {
  batch_id: string;
  run_count: number;
  completed_count: number;
  /** Exact count for status = 'failed' only — use for filter chip counts. */
  failed_count: number;
  /** Groups failed + cancelled — use for header summary text. */
  errored_count: number;
  /** Exact count for status = 'running' only — use for filter chip counts. */
  running_count: number;
  /** Groups running + paused + pending — use for header summary text. */
  active_count: number;
  first_run_at: string | null;
  last_activity_at: string | null;
};

export type BatchStageDetail = {
  id: string;
  stage_number: number;
  name: string | null;
  status: string;
  failure_threshold: number;
  depends_on_stage_ids: string[];
  depends_on_stage_numbers: number[];
  run_count: number;
  completed_count: number;
  failed_count: number;
  active_count: number;
  /** Members waiting on a human — a subset of active_count, never a stage status. */
  attention_count: number;
  /** The not-yet-dispatched part of active_count; active_count − pending_count is the started members. */
  pending_count: number;
  /** Chat ID of the most recently started dispatched flow run for this stage. Null if no runs dispatched. */
  latest_chat_id: string | null;
  /** Workstream IDs from trigger_context.workstreamId across this stage's runs. Empty when not set. */
  workstream_ids: string[];
};

export type StartBatchResult = {
  started: boolean;
  startedStageNumbers?: number[];
  totalEnqueued?: number;
  /** Machine-readable code when `started` is false (e.g. no-stages-defined, all-roots-started). */
  reason?: string;
  totalStages?: number;
  rootStageCount?: number;
  startedRootCount?: number;
};
