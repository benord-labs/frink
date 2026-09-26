import { buildTriggerBubbleMessage } from '../../../../shared/lib/trigger-bubble-marker';
import { buildTriggerSummary } from '../../../../shared/lib/trigger-summary';
import type { TriggerContext } from '../../../../shared/types/trigger-context';
import type { TaskResultRecord } from '../../../../shared/types/task-result';
import { parseTriggerContext } from './trigger-context';

/**
 * Build the chat message for a task: a TriggerBubble marker (display summary) followed by the task
 * description. No trigger context → just the description.
 */
export function buildTaskMessage(task: {
  description: string | null;
  triggerContext?: TaskResultRecord | TriggerContext | null;
}): string {
  const triggerContext = parseTriggerContext(task.triggerContext);

  if (!triggerContext) {
    return task.description ?? '';
  }

  const marker = buildTriggerBubbleMessage(buildTriggerSummary(triggerContext), triggerContext);
  const description = task.description?.trim();
  return description ? `${marker}${description}` : marker;
}
