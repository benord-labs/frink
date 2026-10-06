-- The admission ticket a node_run was dispatched under. The per-node dispatch ceiling counts rows of
-- one ticket, so a Retry or rerun (a new admission) starts with a fresh budget. NULL on older rows.
ALTER TABLE `node_runs` ADD `admission_ticket` integer;--> statement-breakpoint
CREATE INDEX `node_runs_dispatch_slot_idx` ON `node_runs` (`flow_run_id`,`node_id`,`admission_ticket`);
