/**
 * Slash command types for agent chat
 */

type SlashCommandCategory = 'builtin' | 'repository';

/** Which system owns the command (frink = editable; cursor/claude and vendor plugin = read-only) */
type SlashCommandOrigin = 'frink' | 'claude' | 'cursor' | 'plugin';

type SlashCommand = {
  id: string;
  name: string; // Display name without slash, e.g. "clear", "help"
  description: string;
  category: SlashCommandCategory;
  // For repository commands - the prompt content from .md file
  prompt?: string;
  // For repository commands - path to the .md file
  path?: string;
  // For repository commands - the repository name
  repository?: string;
  // For custom commands - hint for expected arguments (e.g. "[file_path]")
  argumentHint?: string;
  // For custom commands - the body consumes $ARGUMENTS, so typed text reaches the prompt
  takesArguments?: boolean;
  // Origin system — only 'frink' commands are editable/deletable from the UI
  origin?: SlashCommandOrigin;
  // Scope — 'user' (global) or 'project' (project-scoped)
  source?: 'user' | 'project';
};

export type SlashCommandOption = SlashCommand & {
  // Full command string for display, e.g. "/plan"
  command: string;
};

// Builtin command action handlers
export type BuiltinCommandAction =
  | { type: 'plan' }
  | { type: 'agent' }
  | { type: 'compact' }
  // Prompt-based commands (send to agent)
  | { type: 'review' }
  | { type: 'pr-comments' }
  | { type: 'release-notes' }
  | { type: 'security-review' }
  | { type: 'commit' }
  | { type: 'worktree-setup' };
