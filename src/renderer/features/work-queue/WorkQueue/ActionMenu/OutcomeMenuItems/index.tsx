import { Check, Trash2, X } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  canCancelTask,
  canDeleteTask,
} from '../../../../../lib/work-queue/task-menu/task-menu-actions';
import type { ActionMenuProps } from '..';
import { MenuAction } from '../MenuAction';

type Props = Pick<
  ActionMenuProps,
  'task' | 'status' | 'isLoading' | 'onStartExecution' | 'onMarkComplete' | 'onCancel' | 'onDelete'
>;

/** The items that settle a task: approve its plan, mark it complete, or leave it. */
export function OutcomeMenuItems({
  task,
  status,
  isLoading,
  onStartExecution,
  onMarkComplete,
  onCancel,
  onDelete,
}: Props): ReactElement {
  return (
    <>
      <MenuAction
        show={status === 'plan_ready'}
        icon={Check}
        label="Start execution"
        onSelect={() => onStartExecution?.(task.id)}
        disabled={isLoading}
        tone="success"
      />
      <MenuAction
        show={(status === 'needs_attention' || status === 'done') && !!onMarkComplete}
        icon={Check}
        label="Mark complete"
        onSelect={() => onMarkComplete?.(task.id)}
        disabled={isLoading}
        tone="success"
      />
      <MenuAction
        show={canCancelTask(task, status)}
        icon={X}
        label="Cancel"
        onSelect={() => onCancel(task.id)}
        disabled={isLoading}
      />
      <MenuAction
        show={canDeleteTask(task, status)}
        icon={Trash2}
        label="Delete"
        onSelect={() => onDelete(task.id)}
        disabled={isLoading}
        tone="danger"
      />
    </>
  );
}
