CREATE TABLE IF NOT EXISTS `flow_run_admissions` (
	`ticket` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`flow_run_id` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`priority_class` text NOT NULL,
	`intent_version` integer NOT NULL,
	`intent_json` text NOT NULL,
	`requested_at` integer NOT NULL,
	`claimed_at` integer,
	`started_at` integer,
	`settled_at` integer,
	`error` text,
	CONSTRAINT `flow_run_admissions_state_check` CHECK (`state` IN ('queued', 'claimed', 'active', 'releasing', 'released', 'failed', 'cancelled')),
	CONSTRAINT `flow_run_admissions_priority_check` CHECK (`priority_class` IN ('start', 'resume')),
	FOREIGN KEY (`flow_run_id`) REFERENCES `flow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_run_admissions_queue_idx` ON `flow_run_admissions` (`priority_class`,`ticket`) WHERE `state` = 'queued';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_run_admissions_occupied_idx` ON `flow_run_admissions` (`state`) WHERE `state` IN ('claimed', 'active', 'releasing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_run_admissions_live_ticket_idx` ON `flow_run_admissions` (`ticket`) WHERE `state` IN ('queued', 'claimed', 'active', 'releasing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_run_admissions_settled_idx` ON `flow_run_admissions` (`settled_at`,`ticket`) WHERE `state` IN ('released', 'failed', 'cancelled') AND `settled_at` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `flow_run_admissions_live_run_uniq` ON `flow_run_admissions` (`flow_run_id`) WHERE `state` IN ('queued', 'claimed', 'active', 'releasing');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flow_run_admissions_protect_occupied_delete`
BEFORE DELETE ON `flow_runs`
WHEN EXISTS (
	SELECT 1 FROM `flow_run_admissions`
	WHERE `flow_run_id` = OLD.`id` AND `state` IN ('claimed', 'active', 'releasing')
)
BEGIN
	SELECT RAISE(ABORT, 'Cannot delete a Flow run while its admission holds resources');
END;
