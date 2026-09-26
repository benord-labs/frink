/**
 * TaskBubble - Visual display of attached task in messages
 * Shows task metadata in a compact card instead of raw text
 */

import { ListTodo } from 'lucide-react';
import { memo } from 'react';
import type { TaskData } from '@/lib/tasks/format-task-message';
import { cn } from '../../../lib/utils';
import { agentsChatBubbleSurfaceClass } from '../main/chat-composer-shell-classes';

type TaskBubbleProps = {
  data: TaskData;
  className?: string;
};

export const TaskBubble = memo(function TaskBubble({ data, className }: TaskBubbleProps) {
  return (
    <div
      className={cn(
        agentsChatBubbleSurfaceClass(),
        'flex items-start gap-2 rounded-xl px-3 py-2 w-full',
        className,
      )}
    >
      <ListTodo className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">Task attached</span>
        </div>
        {data.title && <div className="text-xs text-foreground mt-1 truncate">{data.title}</div>}
        {data.description && (
          <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
            {data.description}
          </div>
        )}
      </div>
    </div>
  );
});
