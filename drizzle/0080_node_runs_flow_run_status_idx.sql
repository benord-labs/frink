DROP INDEX IF EXISTS `node_runs_flow_run_idx`;--> statement-breakpoint
CREATE INDEX `node_runs_flow_run_idx` ON `node_runs` (`flow_run_id`, `status`);
