import { type ActivityRowState, Badge, type BadgeVariant } from '@benord-labs/frink-primitives';
import { ChevronDown } from 'lucide-react';
import { memo, type ReactElement } from 'react';
import {
  ActionMenu,
  type ActionMenuProps,
  type TaskActionListProps,
} from '@/features/work-queue/WorkQueue/ActionMenu';
import type { Task } from '../../../types';
import { TaskActivityRow } from '../../TaskActivityRow';

type Props = {
  canLoadMore: boolean;
  getPresentation: (task: Task) => { compactLabel: string; rowState: ActivityRowState };
  onPromoteTask: (taskId: string) => void;
  selectedTaskId: string;
  taskActions: TaskActionListProps['taskActions'];
  tasks: Task[];
  totalCount: number;
};

const ROW_BADGE_VARIANT: Record<ActivityRowState, BadgeVariant> = {
  neutral: 'default',
  running: 'running',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

export const OtherAttentionTasks = memo(function OtherAttentionTasks({
  canLoadMore,
  getPresentation,
  onPromoteTask,
  selectedTaskId,
  taskActions,
  tasks,
  totalCount,
}: Props): ReactElement | null {
  const otherTasks = tasks.filter((task) => task.id !== selectedTaskId);
  if (otherTasks.length === 0) return null;

  const loadedOtherTaskCount = otherTasks.length;
  const totalOtherTaskCount = Math.max(totalCount - 1, loadedOtherTaskCount);
  const hasUnloadedTasks = canLoadMore && totalOtherTaskCount > loadedOtherTaskCount;

  return (
    <details className="group/disclosure mt-4 border-y border-hairline">
      {/* biome-ignore lint/a11y/useSemanticElements: Chromium exposes native summary as a group; keep its native toggle behavior while announcing the interaction. */}
      <summary
        role="button"
        className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md py-2.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">Other tasks needing attention</span>
          <span className="tabular-nums text-foreground">
            {hasUnloadedTasks
              ? `${loadedOtherTaskCount} shown · ${totalOtherTaskCount} total`
              : loadedOtherTaskCount}
          </span>
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 motion-safe:transition-transform group-open/disclosure:rotate-180"
          aria-hidden
        />
      </summary>
      <ul aria-label="Other tasks needing attention" className="border-t border-hairline">
        {otherTasks.map((task) => {
          const { compactLabel, rowState } = getPresentation(task);
          return (
            <TaskActivityRow
              key={task.id}
              actions={
                <ActionMenu
                  {...taskActions}
                  task={task}
                  status={task.status as ActionMenuProps['status']}
                  chatId={task.result?.chatId ?? task.linkedChatId}
                  triggerClassName="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                />
              }
              task={task}
              state={rowState}
              statusLabel={compactLabel}
              trailing={
                <Badge variant={ROW_BADGE_VARIANT[rowState]} noDot className="px-2 py-0.5 text-xs">
                  {compactLabel}
                </Badge>
              }
              onActivate={() => onPromoteTask(task.id)}
              activationStatusLabel={`${compactLabel.toLowerCase()}, show in spotlight`}
            />
          );
        })}
      </ul>
    </details>
  );
});
