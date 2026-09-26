CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`project_id` text NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	`archived_at` integer,
	`worktree_path` text,
	`branch` text,
	`base_branch` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `sub_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`chat_id` text NOT NULL,
	`session_id` text,
	`mode` text DEFAULT 'agent' NOT NULL,
	`messages` text DEFAULT '[]' NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
