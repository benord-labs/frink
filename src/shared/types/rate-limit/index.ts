/** Claude and Codex subscription plan usage: the rolling windows each provider reports, read in main
 * and shown on Settings → Usage. Utilization percentages, not token spend; none for API keys. */

export type RateLimitWindow = {
  /** 0–100 percent of the window consumed. */
  utilization: number;
  /** Epoch ms when the window resets, or null when the provider didn't report it. */
  resetsAt: number | null;
};

export type RateLimitSnapshot = {
  /** Keyed by the SDK's raw window key (`five_hour`, `seven_day`, `seven_day_opus`, …). */
  windows: Record<string, RateLimitWindow>;
  /** The provider's plan name ('max', 'pro', 'plus', 'prolite', …), or null (API key / unknown). */
  subscriptionType: string | null;
  /** The login the windows belong to, shown so an account switch is visible. */
  email: string | null;
  /** False when plan limits don't apply (API key, Bedrock, Vertex) — `windows` will be empty. */
  available: boolean;
  /** Epoch ms of the most recent update, for an "updated Xm ago" label. */
  updatedAt: number;
};

/** Key prefix for per-model weekly windows (`model_scoped:Fable`); the suffix is the model's name. */
export const MODEL_SCOPED_WINDOW_PREFIX = 'model_scoped:';

/** Display order for the rate-limit windows (present ones only); extras render after, humanized. */
const RATE_LIMIT_WINDOW_ORDER: string[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
  'monthly',
];

/** Human labels for the known windows; unknown keys fall back to a humanized key in the UI. */
const RATE_LIMIT_WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Session (5hr)',
  seven_day: 'Weekly (7 day)',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_oauth_apps: 'Weekly (OAuth apps)',
  monthly: 'Monthly',
};

/** Human label for a window key; unknown keys fall back to a Title-cased form of the raw key. */
export function windowLabel(key: string): string {
  if (key.startsWith(MODEL_SCOPED_WINDOW_PREFIX)) {
    return `Weekly (${key.slice(MODEL_SCOPED_WINDOW_PREFIX.length)})`;
  }
  return (
    RATE_LIMIT_WINDOW_LABELS[key] ??
    key
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

/** Present window keys ordered: the known ones (in display order) first, then any extras. */
export function orderedWindowKeys(presentKeys: string[]): string[] {
  const known = RATE_LIMIT_WINDOW_ORDER.filter((key) => presentKeys.includes(key));
  const extra = presentKeys.filter((key) => !RATE_LIMIT_WINDOW_ORDER.includes(key));
  return [...known, ...extra];
}

/** Rolling length of a window in minutes, or null when it has no fixed length (e.g. `overage`). */
export function windowDurationMins(key: string): number | null {
  if (key === 'five_hour') return 5 * 60;
  if (key.startsWith('seven_day') || key.startsWith(MODEL_SCOPED_WINDOW_PREFIX)) return 7 * 24 * 60;
  if (key === 'monthly') return 30 * 24 * 60;
  return null;
}

/** Share (0–1) of the window's clock already elapsed, or null when its length or reset is unknown. */
export function elapsedShare(key: string, window: RateLimitWindow, now: number): number | null {
  const minutes = windowDurationMins(key);
  if (minutes === null || window.resetsAt === null) return null;
  const length = minutes * 60_000;
  return Math.max(0, Math.min(1, (length - (window.resetsAt - now)) / length));
}

export type LimitPace = 'ahead' | 'on' | 'under';

/** Spending ahead of / on / under the even rate for the elapsed share of the window (±5 points). */
export function paceOf(key: string, window: RateLimitWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(key, window, now);
  if (elapsed === null) return null;
  const gap = window.utilization - elapsed * 100;
  if (gap > 5) return 'ahead';
  if (gap < -5) return 'under';
  return 'on';
}
