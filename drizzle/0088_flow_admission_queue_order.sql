ALTER TABLE `flow_run_admissions` ADD `queue_order` integer;
--> statement-breakpoint
DROP INDEX `flow_run_admissions_queue_idx`;
--> statement-breakpoint
CREATE INDEX `flow_run_admissions_queue_idx` ON `flow_run_admissions` (`priority_class`, coalesce(`queue_order`, `ticket`), `ticket`) WHERE `state` = 'queued';
