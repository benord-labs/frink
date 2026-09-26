import type { BuiltinCommandAction, SlashCommandOption } from '@/lib/commands/types';

/**
 * Prompt texts for prompt-based slash commands
 */
export const COMMAND_PROMPTS: Partial<Record<BuiltinCommandAction['type'], string>> = {
  review:
    'Please review the code in the current context and provide feedback on code quality, potential bugs, and improvements.',
  'pr-comments': 'Generate detailed PR review comments for the changes in the current context.',
  'release-notes': 'Generate release notes summarizing the changes in this codebase.',
  'security-review':
    'Perform a security audit of the code in the current context. Identify vulnerabilities, security risks, and suggest fixes.',
  commit:
    'Закоммить это аккуратно, не трогая больше ничего. Сделай коммит только для staged изменений, не добавляй никакие другие файлы и не вноси дополнительных изменений.',
  'worktree-setup': `Create a worktree setup script for this project.

Your task:
1. Analyze the project to understand what's needed to set up a working copy
2. Create the file .frink/worktrees.json with setup commands

The goal is to reproduce the EXACT same working state as the original repo in the new worktree.

Rules:
- Use only "setup-worktree" key (works on all platforms)
- Install dependencies using the project's package manager (check for bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json)
- Copy ALL real env files that exist (.env, .env.local, .env.development, etc) - NOT example files
- Use $ROOT_WORKTREE_PATH to reference the main repo path
- Don't include build steps unless absolutely necessary for the project to work

Example output for .frink/worktrees.json:
{
  "setup-worktree": [
    "bun install",
    "cp $ROOT_WORKTREE_PATH/.env .env",
    "cp $ROOT_WORKTREE_PATH/.env.local .env.local"
  ]
}

Now analyze this project and create .frink/worktrees.json with the appropriate setup commands.`,
};

/** Debug mode requires a project (ingest paths, logs). Omit from listings when absent. */
export const BUILTIN_DEBUG_COMMAND_ID = 'builtin:debug' as const;

/**
 * Built-in slash commands that are handled client-side
 */
export const BUILTIN_SLASH_COMMANDS: SlashCommandOption[] = [
  {
    id: 'builtin:plan',
    name: 'plan',
    command: '/plan',
    description: 'Switch to Plan mode (creates plan before making changes)',
    category: 'builtin',
  },
  {
    id: 'builtin:agent',
    name: 'agent',
    command: '/agent',
    description: 'Switch to Agent mode (applies changes directly)',
    category: 'builtin',
  },
  {
    id: BUILTIN_DEBUG_COMMAND_ID,
    name: 'debug',
    command: '/debug',
    description: 'Switch to Debug mode (hypothesis-driven debugging)',
    category: 'builtin',
  },
  {
    id: 'builtin:compact',
    name: 'compact',
    command: '/compact',
    description: 'Compact conversation context to reduce token usage',
    category: 'builtin',
  },
  // Prompt-based commands
  {
    id: 'builtin:review',
    name: 'review',
    command: '/review',
    description: 'Ask agent to review your code',
    category: 'builtin',
  },
  {
    id: 'builtin:pr-comments',
    name: 'pr-comments',
    command: '/pr-comments',
    description: 'Ask agent to generate PR review comments',
    category: 'builtin',
  },
  {
    id: 'builtin:release-notes',
    name: 'release-notes',
    command: '/release-notes',
    description: 'Ask agent to generate release notes',
    category: 'builtin',
  },
  {
    id: 'builtin:security-review',
    name: 'security-review',
    command: '/security-review',
    description: 'Ask agent to perform a security audit',
    category: 'builtin',
  },
  {
    id: 'builtin:commit',
    name: 'commit',
    command: '/commit',
    description: 'Commit staged changes carefully without touching anything else',
    category: 'builtin',
  },
  {
    id: 'builtin:worktree-setup',
    name: 'worktree-setup',
    command: '/worktree-setup',
    description: 'Generate worktree setup config with AI',
    category: 'builtin',
  },
];

export type BuiltinCommandsFilterContext = {
  hasProject: boolean;
};

/**
 * Filter builtin commands by search text and optional project context.
 * When `hasProject` is false, `/debug` is excluded. Omitted context defaults to `hasProject: true`.
 */
export function filterBuiltinCommands(
  searchText: string,
  context?: BuiltinCommandsFilterContext,
): SlashCommandOption[] {
  const hasProject = context?.hasProject ?? true;
  const source = hasProject
    ? BUILTIN_SLASH_COMMANDS
    : BUILTIN_SLASH_COMMANDS.filter((cmd) => cmd.id !== BUILTIN_DEBUG_COMMAND_ID);

  if (!searchText) return source;

  const query = searchText.toLowerCase();
  return source.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(query) || cmd.description.toLowerCase().includes(query),
  );
}
