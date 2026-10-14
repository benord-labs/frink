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
  CircleCheck,
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
import { createElement, memo, type ReactElement, type ReactNode, type RefObject } from 'react';
import { ActionMenu, type ActionMenuProps } from '@/features/work-queue/WorkQueue/ActionMenu';
import { buildTriggerSummary } from '../../../../../shared/lib/trigger-summary';
import type {
  ApprovalActions,
  AwaitingApproval,
} from '../../../../lib/work-queue/approvals/use-work-queue-approvals';
import type { Task } from '../../types';
import { getWorkQueueTaskTitle } from '../../utils/task-presentation';

export type AttentionTaskActions = Omit<
  ActionMenuProps,
  'chatId' | 'onStartTask' | 'status' | 'task' | 'triggerClassName'
> & { onStartTask: NonNullable<ActionMenuProps['onStartTask']> };

type Props = {
  /** Runs waiting on an Approval step; they lead the spotlight, longest wait first. */
  approvals?: { gates: AwaitingApproval[]; actions: ApprovalActions };
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

type AttentionTone = 'error' | 'paused' | 'review' | 'warning';

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
  paused: {
    badgeVariant: 'default',
    iconClassName: 'text-muted-fg',
    surfaceClassName: '[--color-primary:var(--muted-fg)]',
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

/** The user's own chat Pause — calm, not a warning: nothing went wrong, it waits on purpose. */
const USER_PAUSED_COPY: AttentionCopy = {
  action: 'Open',
  compactLabel: 'Paused',
  helper: 'You paused this flow. Resume it from its chat when you are ready.',
  icon: CirclePause,
  label: 'Paused by you',
  rowState: 'neutral',
  tone: 'paused',
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
  // A user pause scrubs the agent signal, so without this it falls through to the generic warning.
  if (task.status === 'needs_attention' && task.result?.userPause) {
    return USER_PAUSED_COPY;
  }
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

export const APPROVAL_COPY = {
  compactLabel: 'Needs approval',
  icon: CircleCheck,
  label: 'Waiting for your approval',
  rowState: 'warning',
  tone: 'warning',
} satisfies Omit<AttentionCopyTemplate, 'action'>;

/** A lone gate reads as its own message; several gates in one run are answered from the run. */
export function getApprovalTitle(gate: AwaitingApproval): string {
  if (gate.nodeRunId === null) return `${gate.gateCount} approvals waiting`;
  return gate.message ?? gate.flowName;
}

/** An absolute time stays true between renders, so the live region never re-announces it. */
function formatWaitingSince(since: Date): string {
  const today = since.toDateString() === new Date().toDateString();
  return since.toLocaleString(
    undefined,
    today ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' },
  );
}

type Spotlight = {
  icon: LucideIcon;
  label: string;
  tone: AttentionTone;
  title: string;
  metadata: string | null;
  /** Approvals keep their Flow name in view on narrow windows too. */
  pinMetadata: boolean;
  actions: ReactNode;
  trailing: ReactNode;
};

function taskSpotlight(
  task: Task,
  onOpenTask: (task: Task) => void,
  taskActions: AttentionTaskActions,
  actionRef: RefObject<HTMLButtonElement | null>,
): Spotlight {
  const copy = getAttentionCopy(task);
  return {
    ...copy,
    title: getWorkQueueTaskTitle(task),
    metadata: getTaskMetadata(task),
    pinMetadata: false,
    actions: (
      <>
        <Button
          ref={actionRef}
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
      </>
    ),
    trailing: (
      <ActionMenu
        key={task.id}
        {...taskActions}
        task={task}
        status={task.status as ActionMenuProps['status']}
        chatId={task.result?.chatId ?? task.linkedChatId}
      />
    ),
  };
}

/** Approve is offered only for a lone gate; Open run takes focus when the row is promoted. */
function approvalSpotlight(
  gate: AwaitingApproval,
  actions: ApprovalActions,
  actionRef: RefObject<HTMLButtonElement | null>,
): Spotlight {
  const pending = actions.pending.get(gate.flowRunId);
  const title = getApprovalTitle(gate);
  const waiting = `Waiting since ${formatWaitingSince(gate.waitingSince)}`;
  return {
    ...APPROVAL_COPY,
    title,
    metadata: [title === gate.flowName ? null : gate.flowName, gate.projectName, waiting]
      .filter(Boolean)
      .join(' · '),
    pinMetadata: true,
    actions: (
      <div className="flex shrink-0 items-center gap-2">
        {gate.nodeRunId !== null && (
          <Button
            type="button"
            variant="primary"
            size="xs"
            className="min-[600px]:h-7 min-[600px]:px-3 min-[600px]:text-sm"
            loading={pending === 'approve'}
            disabled={pending !== undefined}
            onClick={() => actions.approve(gate)}
          >
            Approve
          </Button>
        )}
        <Button
          ref={actionRef}
          type="button"
          variant={gate.nodeRunId === null ? 'primary' : 'secondary'}
          size="xs"
          className="min-[600px]:h-7 min-[600px]:px-3 min-[600px]:text-sm"
          aria-label={`Open run of ${gate.flowName}`}
          onClick={() => actions.openRun(gate)}
        >
          Open run
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    ),
    trailing: (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        loading={pending === 'cancel'}
        disabled={pending !== undefined}
        aria-label={`Cancel run of ${gate.flowName}`}
        onClick={() => actions.cancel(gate)}
      >
        Cancel run
      </Button>
    ),
  };
}

export const AttentionCarousel = memo(function AttentionCarousel({
  approvals,
  tasks,
  onOpenTask,
  onSelectTask,
  selectedTaskId,
  spotlightActionRef,
  taskActions,
}: Props): ReactElement | null {
  const gates = approvals?.gates ?? [];
  const itemIds = [...gates.map((gate) => gate.flowRunId), ...tasks.map((task) => task.id)];
  if (itemIds.length === 0) return null;

  const matchedIndex = itemIds.indexOf(selectedTaskId);
  const selectedIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const spotlight =
    approvals && selectedIndex < gates.length
      ? approvalSpotlight(gates[selectedIndex], approvals.actions, spotlightActionRef)
      : taskSpotlight(
          tasks[selectedIndex - gates.length],
          onOpenTask,
          taskActions,
          spotlightActionRef,
        );
  const presentation = ATTENTION_TONE_STYLES[spotlight.tone];
  const cornerIcon = createElement(spotlight.icon, {
    'aria-hidden': true,
    className: `h-3 w-3 min-[600px]:h-4 min-[600px]:w-4 ${presentation.iconClassName}`,
  });
  const hasMultipleItems = itemIds.length > 1;

  const selectOffset = (offset: number) => {
    const nextIndex = (selectedIndex + offset + itemIds.length) % itemIds.length;
    onSelectTask(itemIds[nextIndex]);
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
            {spotlight.label}
          </Badge>
          <span className="line-clamp-2 h-[2lh] text-[12px] font-semibold leading-snug text-foreground min-[600px]:text-base">
            {spotlight.title}
          </span>
          {spotlight.metadata && (
            <span
              className={`text-[12px] text-muted-foreground ${spotlight.pinMetadata ? 'block' : 'hidden min-[600px]:block'}`}
            >
              {spotlight.metadata}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {spotlight.actions}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {spotlight.trailing}
            {hasMultipleItems && (
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
                  {selectedIndex + 1} / {itemIds.length}
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
