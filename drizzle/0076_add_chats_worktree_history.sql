-- Per-chat worktree history: JSON `Record<projectId, worktreePath>` used to auto-restore
-- a chat's previous worktree when it's moved back to a project it visited before.
-- MACHINE-LOCAL — do not sync to cloud (worktree paths are filesystem-local).
ALTER TABLE `chats` ADD `worktree_history` text;
