-- One row per transcript message, so a streaming checkpoint rewrites one message instead of the
-- whole transcript. `seq` is the message's array index; rows hold the message JSON unchanged.
CREATE TABLE `sub_chat_messages` (
	`sub_chat_id` text NOT NULL,
	`seq` integer NOT NULL,
	`message` text NOT NULL,
	PRIMARY KEY(`sub_chat_id`, `seq`),
	FOREIGN KEY (`sub_chat_id`) REFERENCES `sub_chats`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
-- A corrupt transcript copies nothing; row_number keeps seq contiguous if a non-object is skipped.
INSERT INTO `sub_chat_messages` (`sub_chat_id`, `seq`, `message`)
SELECT s.`id`, row_number() OVER (PARTITION BY s.`id` ORDER BY CAST(j.`key` AS INTEGER)) - 1, j.`value`
FROM `sub_chats` s, json_each(s.`messages`) j
WHERE json_valid(s.`messages`) AND json_type(s.`messages`) = 'array' AND json_type(j.`value`) = 'object';--> statement-breakpoint
ALTER TABLE `sub_chats` DROP COLUMN `messages`;
