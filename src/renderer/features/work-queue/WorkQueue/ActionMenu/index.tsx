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
import type { Task } from '../../types';
import { parseTriggerContext } from '../../utils/trigger-context';
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
}: ActionMenuProps): ReactElement {
  const [isTriggerContentOpen, setIsTriggerContentOpen] = useState(false);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const triggerContext = parseTriggerContext(task.triggerContext);
  const canConnectAccount =
    status === 'failed' && task.result?.errorAction === 'open-connect-account';
  const canReview = status === 'plan_ready';
  const canMarkComplete = (status === 'needs_attention' || status === 'done') && !!onMarkComplete;
  const hasChat = !!task.result?.chatId || !!task.linkedChatId;
  const canStart = status === 'pending' && !hasChat && !!onStartTask;
  // One exit per state (decision work-queue-attention-hierarchy): Cancel while the task can still
  // do something, Delete once nothing runs. An interrupted run leaves via Cancel, never a row delete.
  const canCancel =
    status === 'running' ||
    status === 'plan_ready' ||
    status === 'needs_attention' ||
    status === 'interrupted' ||
    (status === 'pending' && hasChat);
  const canDelete =
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'done' ||
    (status === 'pending' && !hasChat);
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
          {triggerContext && (
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
          {canCancel && (
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
              onSelect={() => onDelete(task.id)}
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
      {triggerContext && (
        <TriggerContentDialog
          open={isTriggerContentOpen}
          onOpenChange={setIsTriggerContentOpen}
          triggerContext={triggerContext}
        />
      )}
    </>
  );
}
