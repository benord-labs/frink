-- GitHub PATs are no longer an account type and no project routes to one. The `type` column is
-- free-text with no CHECK constraint, so the value simply stops being written.
DELETE FROM `claude_code_credentials` WHERE `type` = 'github';--> statement-breakpoint
DROP TABLE IF EXISTS `project_github_accounts`;
