import { buildTriggerSummary } from '../../../../../shared/lib/trigger-summary';
import type { Task } from '../../types';

export function getWorkQueueTaskTitle(task: Task): string {
  const triggerSummary = task.triggerContext ? buildTriggerSummary(task.triggerContext) : null;
  return (
    triggerSummary?.title?.trim() ||
    task.title?.trim() ||
    task.description?.trim() ||
    'Untitled task'
  );
}
