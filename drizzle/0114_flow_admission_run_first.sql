ALTER TABLE `flow_run_admissions` ADD `run_first` integer DEFAULT 0 NOT NULL CONSTRAINT `flow_run_admissions_run_first_check` CHECK (`run_first` IN (0, 1) AND (`run_first` = 0 OR `priority_class` = 'start'));
--> statement-breakpoint
DROP INDEX `flow_run_admissions_queue_idx`;
--> statement-breakpoint
CREATE INDEX `flow_run_admissions_queue_idx` ON `flow_run_admissions` ((`priority_class` = 'resume') DESC, `run_first` DESC, coalesce(`queue_order`, `ticket`), `ticket`) WHERE `state` = 'queued';
