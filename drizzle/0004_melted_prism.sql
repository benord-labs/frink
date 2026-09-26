CREATE TABLE `claude_code_credentials` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`oauth_token` text NOT NULL,
	`connected_at` integer,
	`user_id` text
);
