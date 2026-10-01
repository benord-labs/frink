-- A chat keeps the AI account it was created with; project and default changes reach new chats only.
ALTER TABLE `chats` ADD COLUMN `account_id` text REFERENCES `claude_code_credentials`(`id`) ON DELETE set null;--> statement-breakpoint
UPDATE `chats` SET `account_id` = COALESCE(
	(SELECT `account_id` FROM `project_ai_accounts` WHERE `project_ai_accounts`.`project_id` = `chats`.`project_id` LIMIT 1),
	(SELECT `id` FROM `claude_code_credentials` WHERE `is_default` = 1 AND `type` IN ('claude-code', 'codex') LIMIT 1)
);
--> statement-breakpoint
-- A deleted login hands its chats to another login of the same provider, so they resume natively.
CREATE TRIGGER IF NOT EXISTS `chats_account_same_provider_on_delete`
BEFORE DELETE ON `claude_code_credentials`
BEGIN
	UPDATE `chats` SET `account_id` = (
		SELECT `id` FROM `claude_code_credentials`
		WHERE `type` = OLD.`type` AND `id` <> OLD.`id`
		ORDER BY `is_default` DESC, `connected_at` DESC LIMIT 1
	) WHERE `account_id` = OLD.`id`;
END;
