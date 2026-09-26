-- Make chats.project_id nullable for general chats (no project context)
-- SQLite doesn't support ALTER COLUMN, so we recreate the table

PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE "chats_new" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"project_id" text REFERENCES "projects"("id") ON DELETE CASCADE,
	"created_at" integer,
	"updated_at" integer,
	"archived_at" integer,
	"worktree_path" text,
	"branch" text,
	"base_branch" text,
	"pr_url" text,
	"pr_number" integer,
	"task_id" text
);--> statement-breakpoint

INSERT INTO "chats_new" SELECT "id", "name", "project_id", "created_at", "updated_at", "archived_at", "worktree_path", "branch", "base_branch", "pr_url", "pr_number", NULL FROM "chats";--> statement-breakpoint

DROP TABLE "chats";--> statement-breakpoint

ALTER TABLE "chats_new" RENAME TO "chats";--> statement-breakpoint

PRAGMA foreign_keys=ON;
