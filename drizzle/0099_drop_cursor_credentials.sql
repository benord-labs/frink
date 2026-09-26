-- Cursor is no longer an execution provider, so its credential rows can never resolve. The
-- `type` column is free-text with no CHECK constraint, so the value simply stops being written.
-- Per-project overrides in `project_ai_accounts` cascade on delete and need no second statement.
DELETE FROM `claude_code_credentials` WHERE `type` = 'cursor';
