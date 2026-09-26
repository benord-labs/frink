/** Per-batch rollup row the chat sidebar groups its batch children under. */
export type SidebarBatchGroup = {
  batch_id: string;
  flow_name: string;
  run_count: number;
  completed_count: number;
  failed_count: number;
  running_count: number;
  first_run_at: string | null;
  last_activity_at: string | null;
};
