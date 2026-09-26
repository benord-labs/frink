import {
  MODEL_SCOPED_WINDOW_PREFIX,
  type RateLimitSnapshot,
  type RateLimitWindow,
} from '../../../../shared/types/rate-limit';

type UsageWindowField =
  | { utilization?: number | null; resets_at: string | null }
  | null
  | undefined;

/**
 * Minimal shape of `SDKControlGetUsageResponse`. Typed as specific fields (not an index signature) so
 * the SDK response — which carries extra keys like `session` / `behaviors` / `extra_usage` — assigns
 * cleanly. Only the rolling windows + subscription type are read.
 */
export type UsageResponseInput = {
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: UsageWindowField;
    seven_day?: UsageWindowField;
    seven_day_opus?: UsageWindowField;
    seven_day_sonnet?: UsageWindowField;
    seven_day_oauth_apps?: UsageWindowField;
    /** Per-model weekly windows (e.g. Fable); sent by the CLI but not yet in the SDK typings. */
    model_scoped?: Array<{ display_name: string } & NonNullable<UsageWindowField>> | null;
  } | null;
};

const PULL_WINDOW_KEYS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
] as const;

/**
 * One usage read as the whole snapshot for the `email` login. Nothing carries over from an earlier
 * read, because the earlier read may belong to a different Claude login.
 */
export function usageToSnapshot(
  pull: UsageResponseInput,
  now: number,
  email: string | null,
): RateLimitSnapshot {
  const windows: Record<string, RateLimitWindow> = {};
  const limits = pull.rate_limits_available ? pull.rate_limits : null;
  for (const key of PULL_WINDOW_KEYS) {
    const win = reportedWindow(limits?.[key]);
    if (win) windows[key] = win;
  }
  for (const scoped of limits?.model_scoped ?? []) {
    const win = reportedWindow(scoped);
    if (win) windows[MODEL_SCOPED_WINDOW_PREFIX + scoped.display_name] = win;
  }
  return {
    windows,
    subscriptionType: pull.subscription_type,
    email,
    available: pull.rate_limits_available,
    updatedAt: now,
  };
}

/** The window as read, or null when it isn't reported (an omitted, null or non-numeric utilization). */
function reportedWindow(win: UsageWindowField): RateLimitWindow | null {
  const utilization = win?.utilization;
  if (!win || utilization === null || utilization === undefined || !Number.isFinite(utilization)) {
    return null;
  }
  const resetsAtMs = win.resets_at ? Date.parse(win.resets_at) : Number.NaN;
  return {
    utilization: Math.min(100, Math.max(0, utilization)),
    resetsAt: Number.isNaN(resetsAtMs) ? null : resetsAtMs,
  };
}
