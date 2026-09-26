import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { formatTaskMessage, type TaskData } from '@/lib/tasks/format-task-message';
import { trpc } from '../../../lib/trpc';

type UseTaskAttachmentOptions = {
  editorRef: React.RefObject<{ getValue: () => string; setValue: (value: string) => void } | null>;
  onDrop?: () => void;
};

export function useTaskAttachment({ editorRef, onDrop }: UseTaskAttachmentOptions) {
  const [attachedTask, setAttachedTask] = useState<TaskData | null>(null);

  const utils = trpc.useUtils();
  const updateTaskStatusMutation = trpc.tasks.updateStatus.useMutation({
    onSuccess: () => {
      void utils.tasks.listPaginated.invalidate();
      void utils.tasks.listCounts.invalidate();
    },
  });

  // Handle task drop from drag & drop
  const handleTaskDrop = useCallback(
    (e: React.DragEvent) => {
      const taskId = e.dataTransfer.getData('application/task-id');
      if (!taskId) return false;

      const title = e.dataTransfer.getData('application/task-title');
      const description = e.dataTransfer.getData('application/task-description');
      setAttachedTask({ id: taskId, title, description });
      onDrop?.();
      return true;
    },
    [onDrop],
  );

  const clearTask = useCallback(() => {
    setAttachedTask(null);
  }, []);

  // Prepend task message to editor content
  const prependTaskMessage = useCallback(() => {
    if (!attachedTask) return null;

    const taskMessage = formatTaskMessage(attachedTask);
    const editor = editorRef.current;
    const currentValue = editor?.getValue() || '';
    const newValue = currentValue.trim() ? `${taskMessage}\n\n${currentValue}` : taskMessage;
    if (!editor) {
      return attachedTask;
    }

    editor.setValue(newValue);
    clearTask();
    return attachedTask;
  }, [attachedTask, clearTask, editorRef]);

  // Link task to chat by updating task status
  const linkTaskToChat = useCallback(
    async (taskId: string, chatId: string) => {
      try {
        await updateTaskStatusMutation.mutateAsync({
          taskId,
          status: 'running',
          result: { chatId },
        });
      } catch {
        toast.error('Failed to link task to chat', {
          description:
            'The message was sent but the task could not be linked. Manage it from the work queue.',
        });
      }
    },
    [updateTaskStatusMutation],
  );

  return {
    attachedTask,
    setAttachedTask,
    handleTaskDrop,
    prependTaskMessage,
    linkTaskToChat,
    clearTask,
  };
}
