import type { ReactElement } from 'react';
import { ActionMenu, type TaskActionListProps } from '@/features/work-queue/WorkQueue/ActionMenu';
import { formatShortTimeAgo } from '../../../../lib/utils/format-time';
import type { Task } from '../../types';
import { TaskActivityList } from '../TaskActivityList';
import { TaskActivityRow } from '../TaskActivityRow';

type Props = TaskActionListProps;

const MAX_VISIBLE_RUNNING_TASKS = 6;

function getElapsedTime(task: Task): string | null {
  const startedAt = new Date(task.startedAt ?? task.createdAt);
  return Number.isNaN(startedAt.getTime()) ? null : formatShortTimeAgo(startedAt);
}

export function RunningTaskList({ tasks, taskActions, onOpenTask }: Props): ReactElement | null {
  return (
    <TaskActivityList
      ariaLabel="Running tasks"
      heading="Running now, across your projects"
      headingId="work-queue-running-heading"
      initialCount={MAX_VISIBLE_RUNNING_TASKS}
      itemLabel="running task"
      items={tasks}
      renderItem={(task) => {
        const elapsedTime = getElapsedTime(task);

        return (
          <TaskActivityRow
            key={task.id}
            actions={
              <ActionMenu
                {...taskActions}
                task={task}
                status="running"
                chatId={task.result?.chatId ?? task.linkedChatId}
                triggerClassName="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              />
            }
            task={task}
            state="running"
            trailing={elapsedTime}
            onActivate={() => onOpenTask(task)}
            activationStatusLabel="running"
          />
        );
      }}
    />
  );
}
