/**
 * Names of built-in slash commands handled specially (not loaded from the
 * filesystem). Shared so both the renderer command UI ([[builtin-commands]],
 * the rich source of truth for ids/descriptions) and the command expander
 * (renderer chat + flows MCP) skip these names identically. Keep in sync with
 * BUILTIN_SLASH_COMMANDS.
 */
export const BUILTIN_COMMAND_NAMES = [
  'plan',
  'agent',
  'debug',
  'compact',
  'review',
  'pr-comments',
  'release-notes',
  'security-review',
  'commit',
  'worktree-setup',
] as const;
