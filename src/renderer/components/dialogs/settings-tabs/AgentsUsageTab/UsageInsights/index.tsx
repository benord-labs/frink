import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { UsageActivity, UsageHistory } from '../../../../../../shared/types/usage-history';
import { SETTINGS_PANEL_CLASS } from '../../settings-tab-surface';

const MOST_USED = 5;

/** `23` → `11 PM – 12 AM`, in the viewer's locale. */
function hourRange(hour: number): string {
  const at = (h: number) =>
    new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
  return `${at(hour)} – ${at((hour + 1) % 24)}`;
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/30 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right tabular-nums text-foreground">{children}</span>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className={cn(SETTINGS_PANEL_CLASS, 'flex flex-col gap-1')}>
      <h2 className="mb-1 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

const runs = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'run' : 'runs'}`;

function ActivityPanel({
  history,
  activity,
}: {
  history: UsageHistory;
  activity: UsageActivity | undefined;
}): ReactElement {
  const topFlow = activity?.topFlows[0];
  return (
    <Panel title="Highlights">
      <Row label="Flow runs">{activity ? activity.flowRuns.toLocaleString() : '—'}</Row>
      <Row label="Tasks finished">{activity ? activity.tasksFinished.toLocaleString() : '—'}</Row>
      <Row label="Top flow">{topFlow ? `${topFlow.name} · ${runs(topFlow.runs)}` : '—'}</Row>
      <Row label="Favourite model">
        {history.topModel
          ? `${history.topModel.model} · ${Math.round(history.topModel.share * 100)}%`
          : '—'}
      </Row>
      <Row label="Busiest time">
        {history.busiestHour === null ? '—' : hourRange(history.busiestHour)}
      </Row>
    </Panel>
  );
}

function MostUsedPanel({ history }: { history: UsageHistory }): ReactElement {
  const top = history.integrations.slice(0, MOST_USED);
  return (
    <Panel title="Most used">
      {top.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          Skills and integrations your chats use will show here.
        </p>
      ) : (
        top.map((item) => (
          <Row key={`${item.kind}:${item.name}`} label={item.name}>
            <span className="text-muted-foreground">
              {item.kind === 'skill' ? 'Skill' : 'Integration'} · {item.conversations}{' '}
              {item.conversations === 1 ? 'chat' : 'chats'}
            </span>
          </Row>
        ))
      )}
    </Panel>
  );
}

/** Flows and tasks from Frink's database beside the skills and integrations chats used most. */
export function UsageInsights({
  history,
  activity,
}: {
  history: UsageHistory;
  activity: UsageActivity | undefined;
}): ReactElement {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <ActivityPanel history={history} activity={activity} />
      <MostUsedPanel history={history} />
    </div>
  );
}
