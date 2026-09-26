/**
 * AttachedTask Component
 * Displays an attached task as a badge/card above the chat input
 */

import { Button } from '@benord-labs/frink-primitives';
import { ListTodo, X } from 'lucide-react';
import type { ReactElement } from 'react';
import type { TaskData } from '@/lib/tasks/format-task-message';

type Props = {
  task: TaskData;
  onRemove: () => void;
};

export function AttachedTask({ task, onRemove }: Props): ReactElement {
  return (
    <div className="flex items-start gap-2 px-3 py-2 bg-muted/30 border border-border rounded-lg">
      <ListTodo className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">Task attached</span>
        </div>
        {task.title && <div className="text-xs text-foreground mt-1 truncate">{task.title}</div>}
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {task.description.slice(0, 100)}
          {task.description.length > 100 && '...'}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="rounded shrink-0"
        aria-label="Remove attached task"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
