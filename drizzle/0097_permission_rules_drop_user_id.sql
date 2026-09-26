-- Permission rules belong to the machine, not to a signed-in account. Merging rows that were
-- stored per account could inherit an `allow` nobody approved here, so only deny and ask survive.
DELETE FROM `user_permission_rules` WHERE `rule_type` = 'allow';--> statement-breakpoint
DELETE FROM `user_permission_rules` WHERE `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `user_permission_rules` GROUP BY `rule_string`, `rule_type`
);--> statement-breakpoint
-- Any index naming a column blocks DROP COLUMN, so both indexes come down before the column
-- and the unique key is recreated against the narrowed shape.
DROP INDEX IF EXISTS `upr_user_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `upr_unique_idx`;--> statement-breakpoint
ALTER TABLE `user_permission_rules` DROP COLUMN `user_id`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `upr_unique_idx` ON `user_permission_rules` (
	`rule_string`, `rule_type`
);
