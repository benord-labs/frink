/**
 * ActionMenu Component
 * Dropdown menu for task actions (start execution, cancel, delete, etc.)
 */

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@benord-labs/frink-primitives';
import { MoreHorizontal } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { SIDE_EFFECTS_CONFIRM } from '../../../../components/SideEffectsConfirm';
import { useConfirm } from '../../../../components/ui/use-confirm';
import type { TaskMenuStatus } from '../../../../lib/work-queue/task-menu/task-menu-actions';
import type { ConfirmedRecovery, Task } from '../../types';
import { parseTriggerContext } from '../../utils/trigger-context';
import { OutcomeMenuItems } from './OutcomeMenuItems';
import { ProgressMenuItems } from './ProgressMenuItems';
import { TriggerContentDialog } from './TriggerContentDialog';
import { overlayGlass } from '@/lib/overlay-styles';

export type ActionMenuProps = {
  task: Task;
  status: TaskMenuStatus;
  chatId: string | null | undefined;
  isLoading: boolean;
  triggerClassName?: string;
  onStartExecution?: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenChat: (task: Task, chatId: string) => void;
  onStartTask?: (taskId: string, mode: 'agent' | 'plan') => void;
  /** Set when the user confirmed that exact recovery and step; else the row's current one runs. */
  onRetryTask?: (taskId: string, confirmed?: ConfirmedRecovery) => void;
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

export function ActionMenu({ task, triggerClassName, ...menu }: ActionMenuProps): ReactElement {
  const [isTriggerContentOpen, setIsTriggerContentOpen] = useState(false);
  const { confirm, dismiss, confirmDialog } = useConfirm();
  const triggerContext = parseTriggerContext(task.triggerContext);
  const { onRetryTask, chatId } = menu;
  // A confirm asked about one recovery (task, run, chat, attempt) never carries over to the next.
  useEffect(
    () => dismiss(),
    [
      dismiss,
      task.id,
      task.status,
      task.recoveryKind,
      task.confirmSideEffects,
      task.flowRunId,
      chatId,
      task.recoveryNodeRunId,
    ],
  );
  // A started non-agent step (command, request) may repeat what it did, so its Retry confirms. The
  // step is pinned as the dialog opens, and the server refuses it once the row's step has changed.
  const retry = (taskId: string) => {
    const confirmed: ConfirmedRecovery = {
      kind: 'retry',
      recoveryNodeRunId: task.recoveryNodeRunId,
    };
    if (task.confirmSideEffects)
      void confirm(SIDE_EFFECTS_CONFIRM).then((ok) => ok && onRetryTask?.(taskId, confirmed));
    else onRetryTask?.(taskId);
  };

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
          <ProgressMenuItems
            {...menu}
            onRetryTask={onRetryTask && retry}
            task={task}
            hasOriginal={!!triggerContext}
            onViewOriginal={() => setIsTriggerContentOpen(true)}
          />
          <OutcomeMenuItems {...menu} task={task} />
        </DropdownMenuContent>
      </DropdownMenu>
      {triggerContext && (
        <TriggerContentDialog
          open={isTriggerContentOpen}
          onOpenChange={setIsTriggerContentOpen}
          triggerContext={triggerContext}
        />
      )}
      {confirmDialog}
    </>
  );
}
