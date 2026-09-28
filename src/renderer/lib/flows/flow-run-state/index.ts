import { formatRelativeTime } from '../../utils/format-time';

export type FlowRunGlyph =
  | 'never'
  | 'draft'
  | 'live'
  | 'queued'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'awaiting'
  | 'failed';

/** Colour is spent only where the user may act: a live run, a wait on them, a failure. */
export type FlowRunTone = 'quiet' | 'live' | 'warn' | 'fail';

/** `label` names the state in the glyph tooltip; `word` is what the status slot shows. */
export type FlowRunState = { glyph: FlowRunGlyph; tone: FlowRunTone; label: string; word?: string };

type FlowRunFields = {
  // biome-ignore-start lint/style/useNamingConvention: Flow list DTOs intentionally use API snake_case.
  node_count: number | null;
  latest_run_queue_position?: number | null;
  latest_run_admission_requested_at?: string | null;
  // biome-ignore-end lint/style/useNamingConvention: Flow list DTOs intentionally use API snake_case.
};

/** By display status, plus draft, never-run and unknown states. Success has no word. */
const RUN_STATES = {
  running: { glyph: 'live', tone: 'live', label: 'Running now', word: 'Running' },
  pending: { glyph: 'live', tone: 'live', label: 'Starting', word: 'Starting' },
  // biome-ignore lint/style/useNamingConvention: run status keys are snake_case.
  awaiting_input: {
    glyph: 'awaiting',
    tone: 'warn',
    label: 'Your turn: the run is waiting on you',
    word: 'Waiting for your input',
  },
  failed: { glyph: 'failed', tone: 'fail', label: 'Last run failed', word: 'Failed' },
  paused: { glyph: 'paused', tone: 'quiet', label: 'Paused, not waiting on you', word: 'Paused' },
  completed: { glyph: 'done', tone: 'quiet', label: 'Last run succeeded' },
  cancelled: { glyph: 'cancelled', tone: 'quiet', label: 'Last run cancelled', word: 'Cancelled' },
} satisfies Record<string, FlowRunState>;
const DRAFT: FlowRunState = {
  glyph: 'draft',
  tone: 'quiet',
  label: 'Not saved yet',
  word: 'Draft',
};
const NEVER: FlowRunState = {
  glyph: 'never',
  tone: 'quiet',
  label: 'Has not run yet',
  word: 'Never run',
};
const UNKNOWN: FlowRunState = { glyph: 'never', tone: 'quiet', label: 'Unknown status' };

/** Primitives shadow `text-warning` with #dd9000 (2.6:1 on white), so light amber uses its token. */
export const FLOW_RUN_TONE_CLASSES = {
  quiet: 'text-muted-foreground',
  live: 'text-[hsl(var(--status-online-text))]',
  warn: 'text-[hsl(var(--status-warning-solid))] dark:text-warning',
  fail: 'text-destructive',
} satisfies Record<FlowRunTone, string>;

/** Only triggers that start a flow on their own earn a hint; manual is the default, so silent. */
const FLOW_TRIGGER_HINTS = {
  // biome-ignore-start lint/style/useNamingConvention: trigger types are snake_case keys.
  schedule_trigger: 'Runs on a schedule',
  webhook_trigger: 'Runs when its webhook is called',
  post_task_trigger: 'Runs after a task finishes',
  // biome-ignore-end lint/style/useNamingConvention: trigger types are snake_case keys.
} satisfies Record<string, string>;

function hasKey<T extends object>(map: T, key: string): key is Extract<keyof T, string> {
  return Object.hasOwn(map, key);
}

/** The hint for a trigger that starts a flow on its own; manual and unknown triggers have none. */
export function flowTriggerHint(triggerType: string | null): string | undefined {
  return triggerType && hasKey(FLOW_TRIGGER_HINTS, triggerType)
    ? FLOW_TRIGGER_HINTS[triggerType]
    : undefined;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const YEAR_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function queueLabel(flow: FlowRunFields): string {
  const position = flow.latest_run_queue_position;
  const requestedAt = flow.latest_run_admission_requested_at;
  return `Queued${position != null ? ` · #${position}` : ''}${requestedAt ? ` · ${formatRelativeTime(requestedAt)}` : ''}`;
}

/** The latest run as the list shows it: glyph, tone, tooltip label and status-slot word. */
export function flowRunState(flow: FlowRunFields, displayStatus: string | null): FlowRunState {
  if (flow.node_count == null) return DRAFT;
  if (!displayStatus) return NEVER;
  if (displayStatus === 'queued') {
    return {
      glyph: 'queued',
      tone: 'quiet',
      label: 'Queued to run',
      word: queueLabel(flow),
    };
  }
  return hasKey(RUN_STATES, displayStatus) ? RUN_STATES[displayStatus] : UNKNOWN;
}

/** "3d ago" inside a week, then a short date ("15 Sept"), adding the year only when it differs. */
export function formatFlowUpdated(iso: string): string {
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time) || Date.now() - time < WEEK_MS) return formatRelativeTime(iso);
  return (date.getFullYear() === new Date().getFullYear() ? SHORT_DATE : YEAR_DATE).format(date);
}
