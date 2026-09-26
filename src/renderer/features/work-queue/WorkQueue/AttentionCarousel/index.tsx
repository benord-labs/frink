import {
  type ActivityRowState,
  Badge,
  type BadgeVariant,
  Button,
  TileSurface,
} from '@benord-labs/frink-primitives';
import {
  ArrowRight,
  Ban,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CirclePause,
  CircleQuestionMark,
  CircleX,
  ClipboardCheck,
  ListChecks,
  type LucideIcon,
  MessageCircleQuestionMark,
  TriangleAlert,
} from 'lucide-react';
import { createElement, memo, type ReactElement, type RefObject } from 'react';
import { ActionMenu, type ActionMenuProps } from '@/features/work-queue/WorkQueue/ActionMenu';
import { buildTriggerSummary } from '../../../../../shared/lib/trigger-summary';
import type { Task } from '../../types';
import { getWorkQueueTaskTitle } from '../../utils/task-presentation';

export type AttentionTaskActions = Omit<
  ActionMenuProps,
  'chatId' | 'onStartTask' | 'status' | 'task' | 'triggerClassName'
> & { onStartTask: NonNullable<ActionMenuProps['onStartTask']> };

type Props = {
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onSelectTask: (taskId: string) => void;
  selectedTaskId: string;
  spotlightActionRef: RefObject<HTMLButtonElement | null>;
  taskActions: AttentionTaskActions;
};

type AttentionCopy = {
  action: string;
  compactLabel: string;
  helper: string;
  icon: LucideIcon;
  label: string;
  rowState: ActivityRowState;
  tone: AttentionTone;
};

type AttentionCopyTemplate = Omit<AttentionCopy, 'helper'> & {
  helper?: string;
};

type AttentionTone = 'error' | 'review' | 'warning';

const ATTENTION_TONE_STYLES: Record<
  AttentionTone,
  {
    badgeClassName?: string;
    badgeVariant: BadgeVariant;
    iconClassName: string;
    surfaceClassName: string;
  }
> = {
  error: {
    badgeVariant: 'error',
    iconClassName: 'text-danger-fg',
    surfaceClassName: '[--color-primary:var(--danger)]',
  },
  review: {
    badgeClassName: 'border-primary/40 text-primary',
    badgeVariant: 'running',
    iconClassName: 'text-primary',
    surfaceClassName: '[--color-primary:hsl(var(--primary))]',
  },
  warning: {
    badgeVariant: 'warning',
    iconClassName: 'text-warning-fg',
    surfaceClassName: '[--color-primary:var(--warning)]',
  },
};

const DEFAULT_ATTENTION_COPY: AttentionCopyTemplate = {
  action: 'Review',
  compactLabel: 'Needs attention',
  icon: TriangleAlert,
  label: 'Needs your attention',
  rowState: 'warning',
  tone: 'warning',
};

const ATTENTION_COPY_BY_KEY = new Map<string, AttentionCopyTemplate>([
  [
    'plan_ready',
    {
      action: 'Review',
      compactLabel: 'Plan ready',
      helper: 'Approve, edit, or send it back - you decide.',
      icon: ListChecks,
      label: 'Plan ready - needs your review',
      rowState: 'warning',
      tone: 'review',
    },
  ],
  [
    'interrupted',
    {
      action: 'Open',
      compactLabel: 'Interrupted',
      helper: 'Continue from the last saved point.',
      icon: CirclePause,
      label: 'Interrupted - needs your attention',
      rowState: 'warning',
      tone: 'warning',
    },
  ],
  [
    'failed',
    {
      action: 'Review failure',
      compactLabel: 'Failed',
      helper: 'Check the failure before deciding how to continue.',
      icon: CircleX,
      label: 'Failed - needs your attention',
      rowState: 'error',
      tone: 'error',
    },
  ],
  [
    'done',
    {
      action: 'Review result',
      compactLabel: 'Ready for review',
      helper: 'Review the result, then mark it complete.',
      icon: ClipboardCheck,
      label: 'Ready for review',
      rowState: 'warning',
      tone: 'review',
    },
  ],
  [
    'awaiting_input',
    {
      action: 'Answer',
      compactLabel: 'Needs input',
      icon: MessageCircleQuestionMark,
      label: 'Agent waiting - needs your input',
      rowState: 'warning',
      tone: 'warning',
    },
  ],
  [
    'blocked',
    {
      action: 'Review',
      compactLabel: 'Blocked',
      icon: Ban,
      label: 'Blocked - needs your decision',
      rowState: 'warning',
      tone: 'warning',
    },
  ],
  [
    'partial',
    {
      action: 'Review',
      compactLabel: 'Partial result',
      icon: CircleDashed,
      label: 'Partial result - needs your review',
      rowState: 'warning',
      tone: 'warning',
    },
  ],
  [
    'manual_confirmation',
    {
      action: 'Review',
      compactLabel: 'Needs confirmation',
      icon: CircleQuestionMark,
      label: 'Ready - needs your confirmation',
      rowState: 'warning',
      tone: 'review',
    },
  ],
]);

export function getAttentionCopy(task: Task): AttentionCopy {
  const signal = task.result?.agentSignal;
  const copy =
    ATTENTION_COPY_BY_KEY.get(task.status) ??
    ATTENTION_COPY_BY_KEY.get(signal?.state ?? '') ??
    DEFAULT_ATTENTION_COPY;
  const signalHelper = signal?.summary?.trim();

  return {
    ...copy,
    helper: copy.helper ?? (signalHelper || 'Open the task to continue.'),
  };
}

function getTaskMetadata(task: Task): string | null {
  const triggerSummary = task.triggerContext ? buildTriggerSummary(task.triggerContext) : null;
  const metadata = [task.projectName?.trim(), triggerSummary?.subtitle?.trim()].filter(Boolean);
  return metadata.length > 0 ? metadata.join(' · ') : null;
}

export const AttentionCarousel = memo(function AttentionCarousel({
  tasks,
  onOpenTask,
  onSelectTask,
  selectedTaskId,
  spotlightActionRef,
  taskActions,
}: Props): ReactElement | null {
  if (tasks.length === 0) return null;

  const matchedIndex = tasks.findIndex((task) => task.id === selectedTaskId);
  const selectedIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const task = tasks[selectedIndex];
  const copy = getAttentionCopy(task);
  const presentation = ATTENTION_TONE_STYLES[copy.tone];
  const cornerIcon = createElement(copy.icon, {
    'aria-hidden': true,
    className: `h-3 w-3 min-[600px]:h-4 min-[600px]:w-4 ${presentation.iconClassName}`,
  });
  const metadata = getTaskMetadata(task);
  const hasMultipleTasks = tasks.length > 1;

  const selectOffset = (offset: number) => {
    const nextIndex = (selectedIndex + offset + tasks.length) % tasks.length;
    onSelectTask(tasks[nextIndex].id);
  };

  return (
    <section aria-label="Tasks needing your attention">
      <TileSurface
        variant="attention"
        corner={cornerIcon}
        className={`relative shrink-0 p-2 min-[600px]:p-2.5 ${presentation.surfaceClassName}`}
        contentClassName="gap-2 px-3 pt-5 pb-2.5 min-[600px]:gap-3 min-[600px]:px-5 min-[600px]:pt-7 min-[600px]:pb-4"
      >
        <div className="flex flex-col gap-1 min-[600px]:gap-2" aria-live="polite" aria-atomic>
          <Badge
            variant={presentation.badgeVariant}
            noDot
            className={`w-fit gap-1.5 text-[10px] min-[600px]:text-xs ${presentation.badgeClassName ?? ''}`}
          >
            {copy.label}
          </Badge>
          <span className="line-clamp-2 h-[2lh] text-[12px] font-semibold leading-snug text-foreground min-[600px]:text-base">
            {getWorkQueueTaskTitle(task)}
          </span>
          {metadata && (
            <span className="hidden text-[12px] text-muted-foreground min-[600px]:block">
              {metadata}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button
            ref={spotlightActionRef}
            type="button"
            variant="primary"
            size="xs"
            className="shrink-0 min-[600px]:h-7 min-[600px]:px-3 min-[600px]:text-sm"
            onClick={() => onOpenTask(task)}
          >
            {copy.action}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground min-[600px]:block">
            {copy.helper}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ActionMenu
              key={task.id}
              {...taskActions}
              task={task}
              status={task.status as ActionMenuProps['status']}
              chatId={task.result?.chatId ?? task.linkedChatId}
            />
            {hasMultipleTasks && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  iconOnly
                  onClick={() => selectOffset(-1)}
                  aria-label="Show previous task needing attention"
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <span className="min-w-9 text-center text-[10px] tabular-nums text-muted-foreground">
                  {selectedIndex + 1} / {tasks.length}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  iconOnly
                  onClick={() => selectOffset(1)}
                  aria-label="Show next task needing attention"
                >
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </>
            )}
          </div>
        </div>
      </TileSurface>
    </section>
  );
});
