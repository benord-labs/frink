import { Badge, type BadgeVariant, Button, Tabs } from '@benord-labs/frink-primitives';
import { Check, X } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionMenu, type TaskActionListProps } from '@/features/work-queue/WorkQueue/ActionMenu';
import { formatShortTimeAgo } from '../../../../lib/utils/format-time';
import type { Task } from '../../types';
import { TaskActivityList } from '../TaskActivityList';
import { TaskActivityRow } from '../TaskActivityRow';

type Props = Omit<TaskActionListProps, 'onOpenTask'> & {
  canLoadMore: boolean;
  onLoadMore: () => Promise<void>;
};

type HistoryFilter = 'all' | 'completed' | 'cancelled';
type HistoryStatus = Exclude<HistoryFilter, 'all'>;

const HISTORY_FILTERS: { label: string; value: HistoryFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

function isHistoryFilter(value: string): value is HistoryFilter {
  return HISTORY_FILTERS.some((filter) => filter.value === value);
}

const HISTORY_PRESENTATION: Record<
  HistoryStatus,
  { icon: ReactElement; label: string; state: 'success' | 'neutral'; variant: BadgeVariant }
> = {
  completed: {
    icon: <Check className="size-3" aria-hidden />,
    label: 'Completed',
    state: 'success',
    variant: 'success',
  },
  cancelled: {
    icon: <X className="size-3" aria-hidden />,
    label: 'Cancelled',
    state: 'neutral',
    variant: 'error',
  },
};

function getHistoryTime(task: Task): string | null {
  const terminalAt = new Date(task.completedAt ?? task.createdAt);
  return Number.isNaN(terminalAt.getTime()) ? null : formatShortTimeAgo(terminalAt);
}

function HistoryTaskRow({
  task,
  taskActions,
}: {
  task: Task;
  taskActions: TaskActionListProps['taskActions'];
}): ReactElement {
  const status: HistoryStatus = task.status === 'cancelled' ? 'cancelled' : 'completed';
  const { icon, label, state, variant } = HISTORY_PRESENTATION[status];
  const chatId = task.result?.chatId ?? task.linkedChatId;
  const terminalTime = getHistoryTime(task);

  return (
    <TaskActivityRow
      actions={
        <ActionMenu
          {...taskActions}
          task={task}
          status={status}
          chatId={chatId}
          triggerClassName="translate-y-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        />
      }
      task={task}
      state={state}
      statusLabel={label}
      trailing={
        <span className="flex translate-y-0.5 items-center gap-2 leading-none">
          <Badge variant={variant} noDot className="self-center gap-1 px-2 py-0.5 leading-none">
            {icon}
            {label}
          </Badge>
          {terminalTime && <span className="self-center">{terminalTime}</span>}
        </span>
      }
      onActivate={chatId ? () => void taskActions.onOpenChat(task, chatId) : undefined}
      activationStatusLabel={chatId ? label.toLowerCase() : undefined}
    />
  );
}

export function HistoryTaskList({
  canLoadMore,
  onLoadMore,
  tasks,
  taskActions,
}: Props): ReactElement | null {
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  if (tasks.length === 0) return null;

  const counts = {
    all: tasks.length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    cancelled: tasks.filter((task) => task.status === 'cancelled').length,
  };
  const filteredTasks = filter === 'all' ? tasks : tasks.filter((task) => task.status === filter);
  const filteredLabel =
    HISTORY_FILTERS.find((option) => option.value === filter)?.label ?? 'History';

  const handleLoadMore = async () => {
    if (isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      await onLoadMore();
    } catch {
      toast.error('Could not load older history', { description: 'Please try again.' });
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto pr-1">
        <TaskActivityList
          ariaLabel="Completed and cancelled tasks"
          emptyState={
            <p className="py-8 text-center text-xs text-muted-foreground" role="status">
              {canLoadMore
                ? `No loaded ${filteredLabel.toLowerCase()} tasks. Load older history to keep looking.`
                : `No ${filteredLabel.toLowerCase()} tasks in history.`}
            </p>
          }
          heading="History"
          headingActions={
            <Tabs
              className="p-0.5 [&_button]:py-1"
              items={HISTORY_FILTERS.map(({ label, value }) => ({
                value,
                label: (
                  <>
                    <span>{label}</span>
                    <span aria-hidden className="ml-1.5 tabular-nums text-[10px] opacity-70">
                      {counts[value]}
                    </span>
                    <span className="sr-only">{counts[value]} loaded</span>
                  </>
                ),
              }))}
              value={filter}
              onValueChange={(value) => {
                if (isHistoryFilter(value)) setFilter(value);
              }}
            />
          }
          headingId="work-queue-history-heading"
          initialCount={filteredTasks.length}
          itemLabel="history task"
          items={filteredTasks}
          renderItem={(task) => (
            <HistoryTaskRow key={task.id} task={task} taskActions={taskActions} />
          )}
        />
      </div>
      {canLoadMore && (
        <div className="flex shrink-0 justify-end border-t border-hairline pt-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            loading={isLoadingMore}
            onClick={() => void handleLoadMore()}
          >
            Load older history
          </Button>
        </div>
      )}
    </div>
  );
}
