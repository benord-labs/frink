import { ActivityRow, type ActivityRowState, Badge } from '@benord-labs/frink-primitives';
import { Clock3, Mail, Terminal, Workflow } from 'lucide-react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { buildTriggerSummary } from '../../../../../shared/lib/trigger-summary';
import { BRAND_TILE_STYLE, ProviderIcon } from '../../../../components/ProviderIcon';
import type { Task } from '../../types';
import { getWorkQueueTaskTitle } from '../../utils/task-presentation';

type Props = {
  actions?: ReactNode;
  task: Task;
  state: ActivityRowState;
  trailing?: ReactNode;
  onActivate?: () => void;
  activationStatusLabel?: string;
  statusLabel?: string;
};

const SOURCE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  email: Mail,
  schedule: Clock3,
  cron: Clock3,
  cli: Terminal,
  manual: Terminal,
  flow: Workflow,
};

const PROVIDER_SOURCE_IDS = new Map<string, string>([
  ['github', 'github'],
  ['slack', 'slack'],
  ['gmail', 'gmail'],
  ['webhook', 'generic_webhook'],
  ['shortcut', 'shortcut'],
  ['clickup', 'clickup'],
  ['linear', 'linear'],
]);

const SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub',
  slack: 'Slack',
  gmail: 'Gmail',
  email: 'Email',
  webhook: 'Webhook',
  schedule: 'Scheduled',
  cron: 'Scheduled',
  cli: 'CLI',
  manual: 'Manual',
  shortcut: 'Shortcut',
  clickup: 'ClickUp',
  linear: 'Linear',
  flow: 'Flow',
};

function taskSource(task: Task): string {
  const source = (task.triggerContext?.source ?? task.source).trim().toLowerCase();
  return source === 'generic_webhook' ? 'webhook' : source;
}

function sourceLabel(source: string): string {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (!source) return 'Frink';
  return source
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function getTaskCopy(task: Task): { description: string; source: string; title: string } {
  const summary = task.triggerContext ? buildTriggerSummary(task.triggerContext) : null;
  const source = taskSource(task);
  const fallbackDescription = task.description?.trim() || '';
  const title = getWorkQueueTaskTitle(task);
  const context =
    summary?.subtitle?.trim() || (fallbackDescription !== title ? fallbackDescription : '');
  const provider = summary?.provider?.trim() || sourceLabel(source);

  return {
    description: [provider, context].filter(Boolean).join(' · '),
    source,
    title,
  };
}

export function TaskActivityRow({
  actions,
  task,
  state,
  trailing,
  onActivate,
  activationStatusLabel,
  statusLabel,
}: Props): ReactElement {
  const copy = getTaskCopy(task);
  const providerId = PROVIDER_SOURCE_IDS.get(copy.source);
  // biome-ignore lint/style/useNamingConvention: Renders as a component.
  const SourceIcon = SOURCE_ICONS[copy.source] ?? Workflow;
  const projectName = task.projectName?.trim();
  const rowMeta = projectName ? (
    <Badge shape="tag" noDot className="bg-surface/70 px-1.5 py-0.5 text-[10px] text-muted-fg">
      {projectName}
    </Badge>
  ) : undefined;

  return (
    <ActivityRow
      actions={actions}
      className="group"
      state={state}
      statusLabel={statusLabel}
      pulse={state === 'running'}
      leading={
        providerId ? (
          <span
            className="flex size-6 items-center justify-center rounded-md"
            style={BRAND_TILE_STYLE}
          >
            <ProviderIcon providerId={providerId} appearance="tile" className="size-4" />
          </span>
        ) : (
          <SourceIcon />
        )
      }
      title={copy.title}
      description={copy.description}
      meta={rowMeta}
      trailing={trailing}
      trailingWidth="wide"
      onActivate={onActivate}
      actionProps={
        onActivate && activationStatusLabel
          ? { 'aria-label': `${copy.title}, ${activationStatusLabel}` }
          : undefined
      }
    />
  );
}
