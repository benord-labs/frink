import { isCompactCommand } from '../../../../../shared/commands/expand-slash-command';
import {
  type ApprovedPlanContext,
  buildApprovedPlanContextBlock,
} from '../../../../../shared/types/plan';

/**
 * Prepends the approved plan to an execution turn's prompt — the compression-safe handoff that
 * keeps the agent aware of what was approved even when provider session memory is stale.
 *
 * A `/compact` prompt is returned bare: it only dispatches at position 0 (see isCompactCommand),
 * so prepending here would turn a compaction request into an ordinary message the model answers,
 * after the composer has already dropped the user's attached context on the same assumption.
 */
export function applyApprovedPlanContextToPrompt(
  prompt: string,
  approvedPlanContext?: ApprovedPlanContext,
): string {
  if (!approvedPlanContext?.planText || isCompactCommand(prompt)) return prompt;
  return `${buildApprovedPlanContextBlock(approvedPlanContext)}\n\n${prompt}`;
}
