CREATE INDEX IF NOT EXISTS `ccc_user_scope_idx` ON `claude_code_credentials` (`user_id`,`type`,`account_label`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ccc_user_default_idx` ON `claude_code_credentials` (`user_id`,`is_default`);
