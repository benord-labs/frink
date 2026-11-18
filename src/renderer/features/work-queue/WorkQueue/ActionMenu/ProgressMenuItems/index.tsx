import { ExternalLink, Eye } from 'lucide-react';
import type { ReactElement } from 'react';
import { taskMenuRecovery } from '../../../../../lib/work-queue/task-menu/task-menu-actions';
import type { ActionMenuProps } from '..';
import { ConnectAccountMenuItem } from '../ConnectAccountMenuItem';
import { MenuAction } from '../MenuAction';
import { RecoveryMenuItem } from '../RecoveryMenuItem';

type Props = Pick<
  ActionMenuProps,
  'task' | 'status' | 'chatId' | 'isLoading' | 'onOpenChat' | 'onRetryTask'
> & { hasOriginal: boolean; onViewOriginal: () => void };

/** The items that move a task forward: recover it, or look at what it did. */
export function ProgressMenuItems({
  task,
  status,
  chatId,
  isLoading,
  hasOriginal,
  onViewOriginal,
  onOpenChat,
  onRetryTask,
}: Props): ReactElement {
  return (
    <>
      <RecoveryMenuItem
        kind={onRetryTask ? taskMenuRecovery(task, status) : undefined}
        disabled={isLoading}
        onSelect={() => onRetryTask?.(task.id)}
      />
      <MenuAction
        show={!!chatId}
        icon={ExternalLink}
        label={status === 'running' ? 'View progress' : 'View chat'}
        onSelect={() => chatId && onOpenChat(task, chatId)}
      />
      <MenuAction
        show={hasOriginal}
        icon={Eye}
        label="View original content"
        onSelect={onViewOriginal}
      />
      <ConnectAccountMenuItem task={task} status={status} />
    </>
  );
}
