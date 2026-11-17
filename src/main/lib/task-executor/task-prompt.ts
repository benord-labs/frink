import { buildTriggerBubbleMessage } from '../../../shared/lib/trigger-bubble-marker';
import { extractRawTriggerConfig } from '../../../shared/lib/trigger-rule-config';
import { buildTriggerSummary } from '../../../shared/lib/trigger-summary';
import {
  isValidTriggerContext,
  type TriggerContext,
  withTriggerContextDefaults,
} from '../../../shared/types/trigger-context';
import { taskResultSchema, type TaskResultRecord } from '../db/repos/tasks';
import type { Task as DbTask } from '../db/schema';

function parseTriggerContextOrNull(
  triggerContext: DbTask['triggerContext'],
): TriggerContext | null {
  return isValidTriggerContext(triggerContext) ? withTriggerContextDefaults(triggerContext) : null;
}

/**
 * Coerce trigger_context to a plain object for root-level fields (e.g. `baseBranches` from
 * flowTriggerContext spread in node-dispatch). Returns the full object — not only `_config`.
 */
export function parseTriggerContextRootRecord(
  triggerContext: DbTask['triggerContext'],
): TaskResultRecord | undefined {
  const parsed = taskResultSchema.safeParse(triggerContext);
  return parsed.success ? parsed.data : undefined;
}

export function extractTaskTriggerConfig(triggerContext: DbTask['triggerContext']) {
  return extractRawTriggerConfig(parseTriggerContextRootRecord(triggerContext));
}

export function parseTriggerContext(task: DbTask): TriggerContext | null {
  return parseTriggerContextOrNull(task.triggerContext);
}

/**
 * Build the task prompt: trigger context (with UI marker) plus the description. The project name
 * is omitted on purpose; Claude Code's system prompt and Frink's platform block already carry it.
 */
export function buildTaskPrompt(task: DbTask): string {
  const parts: string[] = [];

  const triggerContext = parseTriggerContext(task);
  const rawConfig = extractTaskTriggerConfig(task.triggerContext);
  const showTriggerCardFromFlow = rawConfig?.showTriggerCard;

  // Trigger UI bubble only when flow agent opted in (showTriggerCard true) or flag absent (standalone webhook).
  // Flow tasks with showTriggerCard false omit the bubble — instructions do not reference {{trigger.*}}.
  if (triggerContext && showTriggerCardFromFlow !== false) {
    parts.push(buildTriggerBubbleMessage(buildTriggerSummary(triggerContext), triggerContext));
  }

  if (task.description) {
    parts.push(task.description);
  }

  return parts.join('\n\n');
}

/**
 * Continuation prompt for a retried attempt whose session is RESUMED; asks the agent to re-derive
 * what remains, since compaction may have lost the done/remaining split.
 */
export function buildRetryContinuationPrompt(priorError: string | null): string {
  const stopLine = priorError
    ? `Your previous attempt stopped with an error: ${priorError}`
    : 'Your previous attempt stopped before finishing.';
  return `${stopLine}\n\nThe session has been resumed. Any tool call that never returned a result did NOT complete, and files it was writing may be half-applied. Re-read the original task requirements and your checklist/todo state, work out what remains, and continue from there. Finish with your task signal as usual.`;
}
