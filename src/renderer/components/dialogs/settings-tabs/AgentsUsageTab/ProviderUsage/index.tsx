import { Gauge, type LucideIcon, TrendingDown, TrendingUp } from 'lucide-react';
import { Fragment, type ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  elapsedShare,
  type LimitPace,
  orderedWindowKeys,
  paceOf,
  type RateLimitSnapshot,
  type RateLimitWindow,
  windowLabel,
} from '../../../../../../shared/types/rate-limit';
import { SETTINGS_PANEL_CLASS } from '../../settings-tab-surface';

const PACE = {
  ahead: { label: 'Ahead of pace: spending faster than the window elapses', icon: TrendingUp },
  on: { label: 'On pace with the window', icon: Gauge },
  under: { label: 'Under pace: headroom left for the rest of the window', icon: TrendingDown },
} satisfies Record<LimitPace, { label: string; icon: LucideIcon }>;

/** Green while healthy, amber as it climbs, destructive near the cap. */
function barColorClass(pct: number): string {
  if (pct >= 90) return 'bg-destructive';
  if (pct >= 80) return 'bg-status-warning';
  return 'bg-status-online';
}

/** `resets in 2h 13m`, `resets in 3d 4h`, `resets in 12m`. */
function formatResetsIn(ms: number): string {
  if (ms <= 0) return 'resets now';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${Math.max(1, minutes)}m`;
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The fill is quota LEFT and the hairline marks how much of the window's clock is left, so a fill
 * that stops short of the line means spending ahead of pace.
 */
function WindowBar({
  label,
  used,
  timeLeft,
  resetsAt,
}: {
  label: string;
  used: number;
  timeLeft: number | null;
  resetsAt: number | null;
}): ReactElement {
  const left = 100 - used;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="img"
          aria-label={`${label}: ${left}% left`}
          tabIndex={0}
          className="relative h-4 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="absolute inset-x-0 inset-y-1 rounded-full bg-muted" />
          <div
            className={cn('absolute inset-y-1 left-0 rounded-full', barColorClass(used))}
            style={{ width: `${left}%` }}
          />
          {timeLeft !== null ? (
            <span
              aria-hidden
              className="absolute inset-y-0 w-px -translate-x-1/2 bg-foreground/60"
              style={{ left: `${timeLeft}%` }}
            />
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="text-foreground">{left}% left</span>
        {timeLeft !== null ? (
          <span className="text-muted-foreground">
            {timeLeft}% of the window left. The line is where even spending would be.
          </span>
        ) : null}
        {resetsAt !== null ? (
          <span className="text-muted-foreground">
            Resets {new Date(resetsAt).toLocaleString()}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** One window as three grid cells: label and % left, the bar, then pace and reset countdown. */
function UsageWindowRow({
  windowKey,
  window,
  now,
}: {
  windowKey: string;
  window: RateLimitWindow;
  now: number;
}): ReactElement {
  const used = Math.round(window.utilization);
  const elapsed = elapsedShare(windowKey, window, now);
  const pace = paceOf(windowKey, window, now);
  const paceInfo = pace ? PACE[pace] : null;
  const label = windowLabel(windowKey);
  return (
    <Fragment>
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="ms-auto shrink-0 font-medium tabular-nums text-foreground">
          {100 - used}% left
        </span>
      </span>
      <WindowBar
        label={label}
        used={used}
        timeLeft={elapsed === null ? null : Math.round((1 - elapsed) * 100)}
        resetsAt={window.resetsAt}
      />
      <span className="flex items-center gap-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {paceInfo ? (
          <paceInfo.icon className="size-3.5 shrink-0" aria-label={paceInfo.label} />
        ) : null}
        <span className="ms-auto">
          {window.resetsAt !== null ? formatResetsIn(window.resetsAt - now) : ''}
        </span>
      </span>
    </Fragment>
  );
}

const PLAN_LABELS = new Map([['prolite', 'Pro Lite']]);

/** `max` → `Max`, `prolite` → `Pro Lite`. */
function planLabel(plan: string): string {
  return PLAN_LABELS.get(plan) ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

function UsageFooter({
  manage,
  updatedAt,
  now,
}: {
  manage: { label: string; url: string };
  updatedAt: number | null;
  now: number;
}): ReactElement {
  return (
    <div className="flex items-center justify-between pt-1">
      <button
        type="button"
        onClick={() => window.desktopApi?.openExternal(manage.url)}
        className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {manage.label}
      </button>
      {updatedAt !== null ? (
        <span className="text-xs text-muted-foreground">Updated {formatAgo(now - updatedAt)}</span>
      ) : null}
    </div>
  );
}

function UsageBody({
  provider,
  query,
  unavailable,
  now,
}: Omit<ProviderUsageProps, 'manage'>): ReactElement {
  const { data, isLoading, isError } = query;
  const windows = data
    ? orderedWindowKeys(Object.keys(data.windows)).map((key) => [key, data.windows[key]] as const)
    : [];
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't load {provider} usage. It'll try again shortly.
      </p>
    );
  }
  if (!data?.available) return unavailable;
  if (windows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {provider} hasn't reported any usage for this plan yet.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2">
      {windows.map(([key, window]) => (
        <UsageWindowRow key={key} windowKey={key} window={window} now={now} />
      ))}
    </div>
  );
}

type ProviderUsageProps = {
  provider: string;
  query: { data?: RateLimitSnapshot; isLoading: boolean; isError: boolean };
  manage: { label: string; url: string };
  /** Shown when this provider has no subscription login to read. */
  unavailable: ReactElement;
  now: number;
};

/**
 * One provider's subscription plan: the login it belongs to and how much of each rolling window is
 * left, laid out after t3code's usage limits.
 */
export function ProviderUsage({ manage, ...body }: ProviderUsageProps): ReactElement {
  const { data } = body.query;
  const login = data?.available
    ? [data.subscriptionType && planLabel(data.subscriptionType), data.email]
        .filter(Boolean)
        .join(' · ')
    : '';
  return (
    <section className={cn(SETTINGS_PANEL_CLASS, 'flex flex-col gap-4')}>
      <div className="flex items-baseline justify-between gap-4">
        <h4 className="text-sm font-semibold text-foreground">{body.provider}</h4>
        {login ? <span className="truncate text-xs text-muted-foreground">{login}</span> : null}
      </div>
      <UsageBody {...body} />
      <UsageFooter
        manage={manage}
        updatedAt={data?.available && data.updatedAt > 0 ? data.updatedAt : null}
        now={body.now}
      />
    </section>
  );
}
