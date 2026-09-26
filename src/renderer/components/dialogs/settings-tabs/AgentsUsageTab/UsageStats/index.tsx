import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';
import { formatDayLabel } from '@/lib/utils/format-time';
import type { UsageHistory } from '../../../../../../shared/types/usage-history';
import { SETTINGS_PANEL_CLASS } from '../../settings-tab-surface';

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const TOKENS_HINT =
  "What the AI read and wrote in Frink. It doesn't count re-reads of earlier messages, so it won't match your plan limits.";

const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;

/** The headline numbers across the top of the Usage page. */
export function UsageStats({ history }: { history: UsageHistory }): ReactElement {
  const { busiestDay } = history;
  const stats = [
    {
      label: 'Tokens',
      value: COMPACT.format(history.totalTokens),
      caption: history.since ? `since ${formatDayLabel(history.since)}` : '',
      hint: TOKENS_HINT,
    },
    {
      label: 'Busiest day',
      value: busiestDay ? COMPACT.format(busiestDay.tokens) : '—',
      caption: busiestDay ? formatDayLabel(busiestDay.date) : '',
    },
    {
      label: 'Streak',
      value: days(history.currentStreak),
      caption: `Best ${days(history.longestStreak)}`,
    },
    { label: 'Conversations', value: history.conversations.toLocaleString(), caption: '' },
  ];
  return (
    <dl className={cn(SETTINGS_PANEL_CLASS, 'grid grid-cols-2 gap-y-4 p-0 sm:grid-cols-4')}>
      {stats.map((stat) => (
        <div
          key={stat.label}
          title={stat.hint}
          className="flex flex-col items-center gap-0.5 px-3 py-4 sm:[&:not(:last-child)]:border-r sm:border-border/40"
        >
          <dd className="text-xl font-medium tabular-nums text-foreground">{stat.value}</dd>
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          {stat.caption ? (
            <span className="text-[11px] text-muted-foreground/80">{stat.caption}</span>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
