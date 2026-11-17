/**
 * Rollup row the chat sidebar groups a Flow's chats under: a batch (`batch_id` is the batch; counts
 * are runs) or a Fan Out run that opened item chats (`batch_id` is the run id; counts are items).
 */
export type SidebarBatchGroup = {
  batch_id: string;
  kind: 'batch' | 'run';
  flow_name: string;
  run_count: number;
  completed_count: number;
  failed_count: number;
  running_count: number;
  first_run_at: string | null;
  last_activity_at: string | null;
};
