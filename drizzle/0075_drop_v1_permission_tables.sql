-- Ticket 14 — drop v1 permission tables.
-- Replaced by `project_permission_rules` + `user_permission_rules` (0074).
-- IF EXISTS guards fresh installs that never had these tables.

DROP TABLE IF EXISTS `bash_permissions`;--> statement-breakpoint
DROP TABLE IF EXISTS `project_permissions`;
