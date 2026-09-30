-- A chat stays on the provider it resolved to; deleting its login blocks the chat instead of moving it.
ALTER TABLE `chats` ADD COLUMN `provider` text DEFAULT 'claude-code' NOT NULL;--> statement-breakpoint
UPDATE `chats` SET `provider` = COALESCE(
	(SELECT `type` FROM `claude_code_credentials` WHERE `id` = `chats`.`account_id` AND `type` IN ('claude-code', 'codex')),
	(SELECT c.`type` FROM `project_ai_accounts` p JOIN `claude_code_credentials` c ON c.`id` = p.`account_id` WHERE p.`project_id` = `chats`.`project_id` LIMIT 1),
	(SELECT `type` FROM `claude_code_credentials` WHERE `is_default` = 1 AND `type` IN ('claude-code', 'codex') LIMIT 1),
	'claude-code'
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `chats_account_same_provider_on_delete`;
