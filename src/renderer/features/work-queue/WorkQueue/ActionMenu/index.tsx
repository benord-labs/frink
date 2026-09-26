/**
 * ActionMenu Component
 * Dropdown menu for task actions (start execution, cancel, delete, etc.)
 */

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import {
  Check,
  ClipboardList,
  ExternalLink,
  Eye,
  MoreHorizontal,
  Play,
  Plug,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { assessTaskRetry } from '../../../../../shared/lib/task-retry-policy';
import type { TaskStatus } from '../../../../../shared/types/task-status';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
} from '../../../../lib/atoms';
import { ConfirmDialog } from '../../../../components/ui/confirm-dialog';
import type { Task } from '../../types';
import { parseTriggerContext } from '../../utils/trigger-context';
import { EmailTriggerContentDialog } from './EmailTriggerContentDialog';
import { TriggerContentDialog } from './TriggerContentDialog';
import { overlayGlass } from '@/lib/overlay-styles';

export type ActionMenuProps = {
  task: Task;
  // Queue rows pass the DISPLAY status, including derived `interrupted` from
  // effectiveStatusExpr on top of the persisted TaskStatus values.
  status: TaskStatus | 'interrupted';
  chatId: string | null | undefined;
  isLoading: boolean;
  triggerClassName?: string;
  onStartExecution?: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenChat: (task: Task, chatId: string) => void;
  onStartTask?: (taskId: string, mode: 'agent' | 'plan') => void;
  onRetryTask?: (taskId: string) => void;
  onMarkComplete?: (taskId: string) => void;
  onDismiss?: (taskId: string) => void;
};

type TaskActionMenuHandlers = Omit<
  ActionMenuProps,
  'chatId' | 'status' | 'task' | 'triggerClassName'
>;

export type TaskActionListProps = {
  tasks: Task[];
  taskActions: TaskActionMenuHandlers;
  onOpenTask: (task: Task) => void;
};

export function ActionMenu({
  task,
  status,
  chatId,
  isLoading,
  triggerClassName,
  onStartExecution,
  onCancel,
  onDelete,
  onOpenChat,
  onStartTask,
  onRetryTask,
  onMarkComplete,
  onDismiss,
}: ActionMenuProps): ReactElement {
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isTriggerContentOpen, setIsTriggerContentOpen] = useState(false);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const triggerContext = parseTriggerContext(task.triggerContext);
  const canViewOriginal = !!triggerContext && typeof triggerContext.fullContent === 'object';
  const canConnectAccount =
    status === 'failed' && task.result?.errorAction === 'open-connect-account';
  const canCancel = status === 'pending' || status === 'running' || status === 'done';
  const canReview = status === 'plan_ready';
  const canMarkComplete = (status === 'needs_attention' || status === 'done') && !!onMarkComplete;
  const canDismiss = status === 'needs_attention' && !!onDismiss;
  // `interrupted` is deliberately NOT deletable from the row: a per-row delete of a derived-status
  // flow run can race a concurrent chat-resume and orphan it (delete the task row while the node_run
  // revives). An interrupted run leaves Active by being resumed, or is abandoned by deleting its chat.
  const canDelete =
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'pending' ||
    status === 'plan_ready' ||
    status === 'done';
  const canStart =
    status === 'pending' && !task.result?.chatId && !task.linkedChatId && !!onStartTask;
  const canRetry =
    (status === 'failed' || status === 'needs_attention') &&
    !task.flowRunId &&
    !!onRetryTask &&
    assessTaskRetry(task).canRetry;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`rounded-[2px] ${triggerClassName ?? ''}`}
            aria-label={`More actions for ${task.title || 'task'}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={6} className={`w-44 ${overlayGlass}`}>
          {canStart && (
            <>
              <DropdownMenuItem
                onSelect={() => onStartTask?.(task.id, 'agent')}
                disabled={isLoading}
                className="text-xs"
              >
                <Play className="h-3 w-3" />
                Start task
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onStartTask?.(task.id, 'plan')}
                disabled={isLoading}
                className="text-xs"
              >
                <ClipboardList className="h-3 w-3" />
                Start in plan mode
              </DropdownMenuItem>
            </>
          )}
          {canRetry && (
            <DropdownMenuItem
              onSelect={() => onRetryTask?.(task.id)}
              disabled={isLoading}
              className="text-xs"
            >
              <RotateCcw className="h-3 w-3" />
              Carry on task
            </DropdownMenuItem>
          )}
          {chatId && (
            <DropdownMenuItem onSelect={() => onOpenChat(task, chatId)} className="text-xs">
              <ExternalLink className="h-3 w-3" />
              {status === 'running' ? 'View progress' : 'View chat'}
            </DropdownMenuItem>
          )}
          {canViewOriginal && (
            <DropdownMenuItem onSelect={() => setIsTriggerContentOpen(true)} className="text-xs">
              <Eye className="h-3 w-3" aria-hidden="true" />
              View original content
            </DropdownMenuItem>
          )}
          {canConnectAccount && (
            <DropdownMenuItem
              onSelect={() => {
                setSettingsActiveTab('models');
                setSettingsOpen(true);
              }}
              className="text-xs"
            >
              <Plug className="h-3 w-3" aria-hidden="true" />
              Connect account
            </DropdownMenuItem>
          )}
          {canReview && (
            <DropdownMenuItem
              onSelect={() => onStartExecution?.(task.id)}
              disabled={isLoading}
              className="text-xs"
              tone="success"
            >
              <Check className="h-3 w-3" />
              Start execution
            </DropdownMenuItem>
          )}
          {canMarkComplete && (
            <DropdownMenuItem
              onSelect={() => onMarkComplete?.(task.id)}
              disabled={isLoading}
              className="text-xs"
              tone="success"
            >
              <Check className="h-3 w-3" />
              Mark complete
            </DropdownMenuItem>
          )}
          {canDismiss && (
            <DropdownMenuItem
              onSelect={() => onDismiss?.(task.id)}
              disabled={isLoading}
              className="text-xs"
            >
              <X className="h-3 w-3" />
              Dismiss
            </DropdownMenuItem>
          )}
          {canCancel && !canStart && (
            <DropdownMenuItem
              onSelect={() => onCancel(task.id)}
              disabled={isLoading}
              className="text-xs"
            >
              <X className="h-3 w-3" />
              Cancel
            </DropdownMenuItem>
          )}
          {canDelete && (
            <DropdownMenuItem
              onSelect={() => {
                if (status === 'plan_ready') {
                  setIsDeleteConfirmOpen(true);
                  return;
                }
                onDelete(task.id);
              }}
              disabled={isLoading}
              className="text-xs"
              tone="danger"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={isDeleteConfirmOpen}
        onOpenChange={setIsDeleteConfirmOpen}
        onConfirm={() => onDelete(task.id)}
        title="Delete plan-ready task?"
        description="This removes it from your queue."
      />
      {triggerContext?.source === 'gmail' ? (
        <EmailTriggerContentDialog
          open={isTriggerContentOpen}
          onOpenChange={setIsTriggerContentOpen}
          triggerContext={triggerContext}
        />
      ) : triggerContext ? (
        <TriggerContentDialog
          open={isTriggerContentOpen}
          onOpenChange={setIsTriggerContentOpen}
          triggerContext={triggerContext}
        />
      ) : null}
    </>
  );
}
