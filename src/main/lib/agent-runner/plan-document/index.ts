/** Emit a plan-mode agent's plan file as the `frink-plan` approval card, verbatim: the card
 * shows it and Approve hands the same text to the execution turn (decision plan-card-freshness). */

import { type FrinkPlanData, stripPlanFrontmatter } from '../../../../shared/types/plan';
import type { UIMessageChunk } from '../../claude/types';

const PLAN_SUMMARY_MAX_CHARS = 600;

function truncateSummary(text: string, maxChars = PLAN_SUMMARY_MAX_CHARS): string {
  // Preserve newlines so markdown block elements (headings, lists) render correctly
  // downstream. Only collapse inline whitespace runs and cap blank-line gaps.
  const normalized = text
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  if (normalized.length <= maxChars) return normalized;

  const candidate = normalized.slice(0, maxChars + 1);

  // Prefer ending on sentence punctuation when reasonably close to max.
  const sentenceMatches = [...candidate.matchAll(/[.!?](?=\s|$)/g)];
  const lastSentenceBoundary =
    sentenceMatches.length > 0 ? (sentenceMatches[sentenceMatches.length - 1].index ?? -1) : -1;

  if (lastSentenceBoundary >= Math.floor(maxChars * 0.6)) {
    return `${candidate.slice(0, lastSentenceBoundary + 1).trim()}...`;
  }

  // Otherwise avoid splitting mid-word — match any whitespace (space or newline).
  const whitespaceMatches = [...candidate.matchAll(/\s/g)];
  const wordBoundary =
    whitespaceMatches.length > 0
      ? (whitespaceMatches[whitespaceMatches.length - 1].index ?? -1)
      : -1;
  if (wordBoundary >= Math.floor(maxChars * 0.5)) {
    return `${candidate.slice(0, wordBoundary).trim()}...`;
  }

  return `${normalized.slice(0, maxChars).trim()}...`;
}

/** Short preview of the plan for the collapsed card: its body without frontmatter, truncated. */
function extractPlanSummary(planText: string): string {
  return truncateSummary(stripPlanFrontmatter(planText));
}

type BuildFrinkPlanChunkOptions = {
  /**
   * A Flow run owns approval through resumeFlowRun, so the chat plan card hides its own Approve
   * button and the turn cannot fire alongside the flow's downstream execute node.
   */
  flowDriven?: boolean;
  /**
   * Flow agent node with `autoApprove` (skipReview): no human gate, so the card reads `approved`
   * and the flow advances straight to the downstream execute node.
   */
  autoApproved?: boolean;
};

/**
 * Canonical `frink-plan` tool-input + tool-output chunks for the approval card; `isPlanReadyPart`
 * in shared/types/plan.ts treats them as the plan-ready signal.
 */
export function buildFrinkPlanChunks(
  subChatId: string,
  planText: string,
  planPath: string | null,
  options: BuildFrinkPlanChunkOptions = {},
): UIMessageChunk[] {
  const trimmedPlanText = planText.trim();
  if (!trimmedPlanText) {
    throw new Error('buildFrinkPlanChunks requires non-empty plan text.');
  }
  const callId = `frink-plan-${subChatId}-${Date.now()}`;

  const planData: FrinkPlanData = {
    planId: callId,
    summary: extractPlanSummary(trimmedPlanText),
    planPath: planPath ?? undefined,
    planText: trimmedPlanText,
    status: options.autoApproved ? 'approved' : 'awaiting_approval',
  };
  if (options.flowDriven) planData.flowDriven = true;

  // SAFETY: both literals are the plan-ready members of the chunk union the UI reads.
  return [
    {
      type: 'tool-input-available',
      toolCallId: callId,
      toolName: 'frink-plan',
      input: planData,
    } as UIMessageChunk,
    {
      type: 'tool-output-available',
      toolCallId: callId,
      output: { success: true, planId: callId },
    } as UIMessageChunk,
  ];
}
