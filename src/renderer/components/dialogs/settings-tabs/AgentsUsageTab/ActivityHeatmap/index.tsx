import type { ReactElement } from 'react';
import { type MouseEvent, useCallback, useRef, useState } from 'react';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '@/lib/utils';
import { formatDayLabel } from '@/lib/utils/format-time';
import type {
  UsageHistory,
  UsageHistoryDay,
  UsageLevel,
} from '../../../../../../shared/types/usage-history';
import { SETTINGS_PANEL_CLASS } from '../../settings-tab-surface';

type Filter = 'all' | 'claude' | 'codex';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'OpenAI' },
] satisfies Array<{ id: Filter; label: string }>;

const LEVEL_CLASS = [
  'bg-muted/70',
  'bg-primary/25',
  'bg-primary/45',
  'bg-primary/70',
  'bg-primary',
] satisfies Record<UsageLevel, string>;

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** What one day adds up to under the current filter, e.g. `6.7M tokens · 12 chats`. */
function daySummary(day: UsageHistoryDay, filter: Filter): string {
  const tokens = filter === 'all' ? day.claude + day.codex : day[filter];
  if (tokens <= 0) return 'No activity';
  const chats = filter === 'all' ? day.chats.claude + day.chats.codex : day.chats[filter];
  const chatText = chats > 0 ? ` · ${chats} ${chats === 1 ? 'chat' : 'chats'}` : '';
  return `${COMPACT.format(tokens)} tokens${chatText}`;
}

type Hovered = { day: UsageHistoryDay; x: number; y: number };

function DayTooltip({ hovered, filter }: { hovered: Hovered; filter: Filter }): ReactElement {
  return (
    <div
      role="tooltip"
      className={cn(
        'pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border px-2 py-1 text-xs text-popover-foreground shadow-lg',
        overlayGlass,
      )}
      style={{ left: hovered.x, top: hovered.y - 6 }}
    >
      <div className="font-medium">{formatDayLabel(hovered.day.date, true)}</div>
      <div className="text-muted-foreground">{daySummary(hovered.day, filter)}</div>
    </div>
  );
}

/** A month label over the first week that starts in it. */
function monthLabels(weeks: UsageHistoryDay[][]): Array<{ week: number; label: string }> {
  const labels: Array<{ week: number; label: string }> = [];
  weeks.forEach((week, index) => {
    const month = week[0].date.slice(0, 7);
    if (index === 0 || month !== weeks[index - 1][0].date.slice(0, 7)) {
      const [year, m] = month.split('-').map(Number);
      labels.push({
        week: index,
        label: new Date(year, m - 1, 1).toLocaleDateString(undefined, { month: 'short' }),
      });
    }
  });
  return labels.slice(1);
}

function FilterTabs({
  filter,
  onChange,
}: {
  filter: Filter;
  onChange: (f: Filter) => void;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label="Show activity for"
      className="flex gap-1 rounded-lg bg-muted/60 p-0.5"
    >
      {FILTERS.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={filter === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs',
            filter === option.id
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A year of daily activity, like a contributions graph. The filter shows only when both
 * Claude and Codex have been used. */
export function ActivityHeatmap({ history }: { history: UsageHistory }): ReactElement {
  const [filter, setFilter] = useState<Filter>('all');
  // Stable, so it runs once on mount and never undoes the user's own scrolling.
  const scrollToLatest = useCallback((el: HTMLDivElement | null) => {
    el?.scrollTo({ left: el.scrollWidth });
  }, []);
  const sectionRef = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const bothProviders = history.providers.claude && history.providers.codex;
  const shown = bothProviders ? filter : 'all';
  // One tooltip for the whole grid, placed over the hovered day, instead of one per cell.
  const hover = (day: UsageHistoryDay) => (event: MouseEvent<HTMLElement>) => {
    const box = sectionRef.current?.getBoundingClientRect();
    const cell = event.currentTarget.getBoundingClientRect();
    if (box) setHovered({ day, x: cell.left - box.left + cell.width / 2, y: cell.top - box.top });
  };
  return (
    <section ref={sectionRef} className={cn(SETTINGS_PANEL_CLASS, 'relative flex flex-col gap-3')}>
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Activity</h2>
          <span className="text-xs text-muted-foreground">Tokens per day</span>
        </div>
        {bothProviders ? <FilterTabs filter={shown} onChange={setFilter} /> : null}
      </div>
      {/* Narrow windows scroll; open on the latest weeks, not a year ago. */}
      <div ref={scrollToLatest} className="flex flex-col gap-1.5 overflow-x-auto">
        <div
          role="img"
          aria-label="Tokens per day over the past year"
          className="flex gap-[3px]"
          onMouseLeave={() => setHovered(null)}
        >
          {history.weeks.map((week) => (
            <div key={week[0].date} className="flex flex-col gap-[3px]">
              {week.map((day, weekday) =>
                day.date ? (
                  <span
                    key={day.date}
                    onMouseEnter={hover(day)}
                    className={cn(
                      'size-[11px] rounded-[3px]',
                      LEVEL_CLASS[day.level[shown]],
                      hovered?.day.date === day.date && 'ring-1 ring-foreground/60',
                    )}
                  />
                ) : (
                  <span key={`future-${weekday}`} className="size-[11px]" />
                ),
              )}
            </div>
          ))}
        </div>
        <div className="relative h-4 text-[11px] text-muted-foreground">
          {monthLabels(history.weeks).map((month) => (
            <span key={month.week} className="absolute" style={{ left: `${month.week * 14}px` }}>
              {month.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
        <span>Less</span>
        {LEVEL_CLASS.map((level) => (
          <span key={level} className={cn('size-[11px] rounded-[3px]', level)} />
        ))}
        <span>More</span>
      </div>
      {hovered ? <DayTooltip hovered={hovered} filter={shown} /> : null}
    </section>
  );
}
