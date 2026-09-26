/**
 * Constants for NewChatForm component
 * All UI strings, magic numbers, and configuration values
 */

const titles = [
  'What are we building today?',
  'Ship it mode: what is the mission?',
  'What needs to happen next?',
  'What should we tackle first?',
  'What would make today a win?',
  'What idea are we bringing to life?',
  'What should we automate right now?',
  'What are we cooking up today?',
  'Where should we make progress first?',
];

export const STRINGS = {
  // Main title
  TITLE: titles[Math.floor(Math.random() * titles.length)],

  // Placeholders
  INPUT_PLACEHOLDER: 'Plan, @ for context, / for commands',
  BRANCH_SEARCH_PLACEHOLDER: 'Search branches...',

  // Buttons
  BUTTON_ALL_PROJECTS: 'All projects',
  BUTTON_CREATE: 'Create',
  BUTTON_SETTINGS: 'Settings',
  BUTTON_DISMISS: 'Dismiss',

  // Mode labels
  MODE_AGENT: 'Agent',
  MODE_PLAN: 'Plan',
  MODE_DEBUG: 'Debug',

  // Branch labels
  BRANCH_DEFAULT: 'main',
  BRANCH_NO_BRANCHES: 'No branches found.',
  BRANCH_TAG_DEFAULT: 'default',
  BRANCH_TAG_LOCAL: 'local',
  BRANCH_TAG_REMOTE: 'remote',

  // Tooltips
  TOOLTIP_AGENT: 'Apply changes directly without a plan',
  TOOLTIP_PLAN: 'Create a plan before making changes',
  TOOLTIP_DEBUG: 'Hypothesis-driven debugging with instrumentation',

  // Worktree banner
  WORKTREE_BANNER_MESSAGE:
    'Configure a worktree setup script to install dependencies or copy environment variables.',

  // Empty states
  EMPTY_NO_BRANCHES: 'No branches found.',
} as const;

export const LIMITS = {
  MAX_IMAGES: 5,
  MAX_CHAT_NAME_LENGTH: 50,
  INPUT_MAX_HEIGHT: 240,
  INPUT_MIN_HEIGHT_MOBILE: 56,
  INPUT_MIN_HEIGHT_DESKTOP: 44,
  BRANCH_LIST_MAX_HEIGHT: 300,
  BRANCH_ITEM_HEIGHT: 28,
  BRANCH_LIST_OVERSCAN: 5,
  TOOLTIP_DELAY_MS: 1000,
  AUTOFOCUS_DELAY_MS: 150,
  VIRTUALIZE_MEASURE_DELAY_MS: 0,
  BRANCHES_STALE_TIME_MS: 30000,
  DRAFT_RESTORE_DELAY_MS: 50,
} as const;

export const CSS_CLASSES = {
  BUTTON_BASE:
    'h-7 w-7 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md',
  DROPDOWN_TRIGGER:
    'flex items-center gap-1.5 px-2 py-1 text-sm text-muted-foreground hover:text-foreground transition-[background-color,color] duration-150 ease-out rounded-md hover:bg-muted/50 outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring/70',
  DROPDOWN_TRIGGER_DISABLED: 'opacity-70 cursor-not-allowed',
  BRANCH_TAG_LOCAL: 'bg-blue-500/10 text-blue-500',
  BRANCH_TAG_REMOTE: 'bg-orange-500/10 text-orange-500',
  WORKTREE_BANNER:
    'absolute left-0 right-0 top-full mt-2 ml-[5px] mr-[5px] p-3 pb-4 bg-muted/50 rounded-lg border border-border space-y-3',
} as const;
