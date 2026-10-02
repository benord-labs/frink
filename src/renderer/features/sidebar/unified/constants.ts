/**
 * Constants for Unified Sidebar
 */

export const STRINGS = {
  /** Sidebar header wordmark: keyboard/tap target for logo easter-egg and bounce. */
  FRINK_LOGO_INTERACTIVE: 'Frink, tap for effects',
  SEARCH_PLACEHOLDER: 'Search...',
  /** Archive mode narrows search to the archived list — the placeholder states the scope. */
  SEARCH_ARCHIVED_PLACEHOLDER: 'Search archived...',
  NEW_CHAT: 'New Chat',
  NEW_PANE: 'New Pane',
  NEW_FOLDER: 'New Folder',
  SPLIT_PANE: 'Split Pane',
  ADD_PANE: 'Add Pane',
  PROJECTS: 'Projects',
  GENERAL_CHATS: 'General Chats',
  SETTINGS: 'Settings',
  ARCHIVE: 'Archive',
  DISCORD: 'Join our Discord',
  CLOSE_SIDEBAR: 'Close sidebar',
  NO_PROJECTS: 'No projects registered',
  NO_CHATS: 'No chats yet',
  UNTITLED_CHAT: 'Untitled chat',
  LOAD_PROJECT_PLACEHOLDER: 'Load a project to start chatting',
  DELETE_ALL_CHATS_IN_FOLDER: 'Delete all chats in this folder',
} as const;

/** Community Discord invite, opened from the sidebar footer. */
export const DISCORD_INVITE_URL = 'https://discord.com/invite/kwWJCGFG6n';

export const TIMING = {
  TOOLTIP_DELAY_MS: 500,
  EXPAND_ANIMATION_MS: 200,
  CHAT_POLL_INTERVAL_MS: 5_000,
} as const;

export const PAGINATION = {
  CHAT_FETCH_PAGE_SIZE: 100,
  FOLDER_CHAT_PAGE_SIZE: 30,
} as const;

export const SIDEBAR_ACTIVE_TASK_STATUSES = ['pending', 'running', 'plan_ready', 'done'] as const;

// In-flight statuses whose linked task must be STOPPED before a destructive chat action
// (delete/archive). Deliberately NARROWER than backend CANCELLABLE_STATUSES — it omits two of the
// backend-cancellable statuses on purpose:
//   - `done`: execution finished, awaiting user review — terminal; the backend rejects cancelling it,
//     so a done-task chat deletes straight through like completed/failed/cancelled.
//   - `needs_attention`: agent is paused awaiting human input — do NOT auto-stop it on chat delete;
//     leave the user's pending decision intact rather than silently cancelling a task they may resume.
export const SIDEBAR_STOPPABLE_TASK_STATUSES = ['pending', 'running', 'plan_ready'] as const;
export const SIDEBAR_TRACKED_TASK_STATUSES = [
  ...SIDEBAR_ACTIVE_TASK_STATUSES,
  'needs_attention',
  'failed',
] as const;

/**
 * Display statuses for a sidebar pill = the QUERIED tracked set PLUS `cancelled`, which is
 * deliberately NOT in the query list. `cancelled` is reached only via the done→cancelled substitution
 * in {@link flowAwareStatus} (the underlying task stays `done`), giving a cancelled/interrupted flow
 * chat a neutral pill that agrees with runs-history. Keeping it out of the query avoids dragging every
 * historical cancelled task into the sidebar payload.
 */
export type SidebarTaskStatus = (typeof SIDEBAR_TRACKED_TASK_STATUSES)[number] | 'cancelled';

type SidebarTaskPresentation = {
  label: string;
  shortLabel: string;
  ariaLabel: string;
  textClassName: string;
  dotClassName: string;
  bgClassName: string;
  iconClassName: string;
};

export const SIDEBAR_TASK_PRESENTATION: Record<SidebarTaskStatus, SidebarTaskPresentation> = {
  // Text/icon use --status-warning-foreground (theme-split, AA both themes); the pale
  // --status-warning is dots/fills only — as text it reads ~1.2:1 on a light background.
  pending: {
    label: 'Queued',
    shortLabel: 'Queue',
    ariaLabel: 'Task queued',
    textClassName: 'text-warning',
    dotClassName: 'bg-[hsl(var(--status-warning))]',
    bgClassName: 'bg-[hsl(var(--status-warning)/0.12)]',
    iconClassName: 'text-warning',
  },
  // biome-ignore lint/style/useNamingConvention: DB enum value used as discriminator
  plan_ready: {
    label: 'Plan ready',
    shortLabel: 'Plan',
    ariaLabel: 'Plan awaiting approval',
    textClassName: 'text-info-fg',
    dotClassName: 'bg-info-fg',
    bgClassName: 'bg-info-fg/12',
    iconClassName: 'text-info-fg',
  },
  running: {
    label: 'Running',
    shortLabel: 'Running',
    ariaLabel: 'Task running',
    textClassName: 'text-[hsl(var(--primary))]',
    dotClassName: 'bg-[hsl(var(--primary))]',
    bgClassName: 'bg-[hsl(var(--primary)/0.12)]',
    iconClassName: 'text-[hsl(var(--primary))]',
  },
  // biome-ignore lint/style/useNamingConvention: DB enum value used as discriminator
  needs_attention: {
    label: 'Needs attention',
    shortLabel: 'Attention',
    ariaLabel: 'Task needs attention',
    textClassName: 'text-warning',
    dotClassName: 'bg-[hsl(var(--status-warning))]',
    bgClassName: 'bg-[hsl(var(--status-warning)/0.12)]',
    iconClassName: 'text-warning',
  },
  // Review gate, not terminal: work finished but the user hasn't confirmed the outcome. Green
  // (success family) — primary would read as a sibling of the running/plan_ready blues; the label
  // carries the review distinction (completed never renders in the sidebar).
  // Text/icon use --status-online-text (140 60% 26% light / bright 140 75% 73% dark): ~6.65:1 on
  // white, ~6:1 over the worst-case hover/selected row overlay bleeding through the translucent
  // /0.1 fill, ~12.3:1 on dark --card — passes AA in every row state, so unlike `cancelled` below
  // this pill keeps its translucent fill (no opaque --card needed).
  done: {
    label: 'Ready for review',
    shortLabel: 'Review',
    ariaLabel: 'Task ready for review',
    textClassName: 'text-[hsl(var(--status-online-text))]',
    dotClassName: 'bg-[hsl(var(--status-online))]',
    bgClassName: 'bg-[hsl(var(--status-online)/0.1)]',
    iconClassName: 'text-[hsl(var(--status-online-text))]',
  },
  failed: {
    label: 'Failed',
    shortLabel: 'Fail',
    ariaLabel: 'Task failed',
    textClassName: 'text-[hsl(var(--destructive))]',
    dotClassName: 'bg-[hsl(var(--destructive))]',
    bgClassName: 'bg-[hsl(var(--destructive)/0.12)]',
    iconClassName: 'text-[hsl(var(--destructive))]',
  },
  // Neutral by design: a cancelled/interrupted flow run is recoverable, not a failure — muted tokens
  // (no destructive red, no online green) so it reads calm but explicit, matching runs-history.
  // Fill is OPAQUE `--card` (not the siblings' translucent `/0.12`): `--muted-foreground` is the
  // lowest-contrast token, so a translucent tint or a transparent pill lets the row's selected/hover
  // overlays bleed through and drop the 10px label under WCAG AA. An opaque card fill pins the label's
  // background regardless of row state → `--muted-foreground` on `--card` is ~4.83:1 light / ~5.11:1
  // dark (passes AA), in every row state.
  cancelled: {
    label: 'Cancelled',
    shortLabel: 'Cancelled',
    ariaLabel: 'Flow run cancelled',
    textClassName: 'text-[hsl(var(--muted-foreground))]',
    dotClassName: 'bg-[hsl(var(--muted-foreground))]',
    bgClassName: 'bg-[hsl(var(--card))]',
    iconClassName: 'text-[hsl(var(--muted-foreground))]',
  },
} as const;

/* ── Regular chat active states ─────────────────────────────────────── */

type ChatActiveState = 'loading' | 'pendingQuestion' | 'pendingPlan' | 'unseenChanges';

type ChatStatePresentation = {
  label: string;
  ariaLabel: string;
  iconClassName: string;
  textClassName: string;
  bgClassName: string;
  dotClassName: string;
  /** When false, only the icon is colored — no pill badge is shown */
  showPill: boolean;
};

export const CHAT_STATE_PRESENTATION: Record<ChatActiveState, ChatStatePresentation> = {
  loading: {
    label: 'Running',
    ariaLabel: 'Agent is running',
    iconClassName: 'text-[hsl(var(--primary))]',
    textClassName: 'text-[hsl(var(--primary))]',
    bgClassName: 'bg-[hsl(var(--primary)/0.12)]',
    dotClassName: 'bg-[hsl(var(--primary))]',
    showPill: false, // corner activity dot is enough — pills reserved for task/flow "Run"
  },
  pendingQuestion: {
    label: 'Waiting',
    ariaLabel: 'Waiting for your response',
    // Attention state — uses the sanctioned amber --status-warning family (was a banned raw blue),
    // so the whole sidebar reads on one status palette: green=ready, amber=needs you, red=failed,
    // primary=running, muted=cancelled.
    iconClassName: 'text-warning',
    textClassName: 'text-warning',
    bgClassName: 'bg-[hsl(var(--status-warning)/0.12)]',
    dotClassName: 'bg-[hsl(var(--status-warning))]',
    showPill: true,
  },
  pendingPlan: {
    label: 'Plan',
    ariaLabel: 'Plan awaiting approval',
    // Info (cyan) is the one status hue the sidebar hadn't claimed, so it reads as its own state
    // rather than a second amber. --info-fg is the AA-safe text/icon step of that role and flips
    // per theme at the token layer, so no dark: variant is needed here.
    iconClassName: 'text-info-fg',
    textClassName: 'text-info-fg',
    bgClassName: 'bg-info-fg/12',
    dotClassName: 'bg-info-fg',
    showPill: false,
  },
  unseenChanges: {
    label: 'Updated',
    ariaLabel: 'Has unseen changes',
    iconClassName: 'text-[hsl(var(--status-online-text))]',
    textClassName: 'text-[hsl(var(--status-online-text))]',
    bgClassName: 'bg-[hsl(var(--status-online)/0.1)]',
    dotClassName: 'bg-[hsl(var(--status-online))]',
    showPill: false, // green icon is enough — informational only
  },
};

/**
 * Left-icon live "running" signal: a live agent stream (`loading`) OR a polled `running` task.
 * Independent of the right status pill, so a follow-up message re-runs the left icons while the
 * pill keeps resting on a terminal status like "Review" (done).
 *
 * A live pending question suppresses it: a held AskUserQuestion keeps its task `running` in the DB
 * for the whole hold window (nothing is persisted until the park — see
 * docs/decisions/agent-user-question-mechanism.md), so the row must read "needs you", not "busy".
 */
export function isChatRunning(
  chatState: ChatActiveState | null,
  taskStatus?: SidebarTaskStatus,
): boolean {
  return chatState !== 'pendingQuestion' && (chatState === 'loading' || taskStatus === 'running');
}

/** Resolve the active chat state (priority order), or null if idle */
export function getChatActiveState(chat: {
  isLoading: boolean;
  hasPendingQuestion: boolean;
  hasPendingPlan: boolean;
  hasUnseenChanges: boolean;
}): ChatActiveState | null {
  if (chat.hasPendingQuestion) return 'pendingQuestion';
  if (chat.hasPendingPlan) return 'pendingPlan';
  if (chat.isLoading) return 'loading';
  if (chat.hasUnseenChanges) return 'unseenChanges';
  return null;
}
