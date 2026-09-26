import { Button } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import { ActionMenu, type TaskActionListProps } from '@/features/work-queue/WorkQueue/ActionMenu';
import { TaskActivityList } from '../TaskActivityList';
import { TaskActivityRow } from '../TaskActivityRow';

type Props = TaskActionListProps & {
  isLoading: boolean;
  onStartTask: (taskId: string, mode: 'agent') => void;
};

const MAX_VISIBLE_INBOX_TASKS = 6;

export function InboxTaskList({
  tasks,
  isLoading,
  taskActions,
  onOpenTask,
  onStartTask,
}: Props): ReactElement | null {
  return (
    <TaskActivityList
      ariaLabel="Tasks ready to start"
      heading="Inbox, ready to start"
      headingId="work-queue-inbox-heading"
      initialCount={MAX_VISIBLE_INBOX_TASKS}
      itemLabel="Inbox task"
      items={tasks}
      renderItem={(task) => {
        const hasLinkedChat = Boolean(task.result?.chatId ?? task.linkedChatId);
        const action = hasLinkedChat ? (
          <Button
            variant="secondary"
            size="xs"
            loading={isLoading}
            onClick={() => onOpenTask(task)}
          >
            Open chat
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="xs"
            loading={isLoading}
            onClick={() => onStartTask(task.id, 'agent')}
          >
            Start task
          </Button>
        );

        return (
          <TaskActivityRow
            key={task.id}
            task={task}
            state="neutral"
            actions={
              <>
                {action}
                <ActionMenu
                  {...taskActions}
                  task={task}
                  status="pending"
                  chatId={task.result?.chatId ?? task.linkedChatId}
                  triggerClassName="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                />
              </>
            }
          />
        );
      }}
    />
  );
}
