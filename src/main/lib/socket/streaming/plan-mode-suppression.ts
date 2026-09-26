import type { UIMessageChunk } from '../../claude/types';

/**
 * Which stream chunks a plan-mode turn hides, so the canonical frink-plan card is the only plan
 * artifact the transcript shows.
 *
 * Pure predicates over a chunk plus the turn's suppression flags — split out of executor.ts, which
 * sits on its size ratchet. Nothing outside the executor and its tests consumes them.
 */
export function shouldSuppressNativePlanToolChunk(
  chunk: UIMessageChunk,
  suppressNativePlanTools: boolean,
  toolNameByCallId?: Map<string, string>,
): boolean {
  if (!suppressNativePlanTools) return false;
  if (chunk.type === 'tool-input-available') {
    return (
      chunk.toolName === 'PlanWrite' ||
      // Claude Code SDK writes the plan `.md` with `Write` (not PlanWrite); suppress IPC so
      // frink-plan is the only visible plan surface (see shouldSuppressNativePlanStreamChunk).
      chunk.toolName === 'Write'
    );
  }
  if (chunk.type === 'tool-output-available') {
    const name =
      'toolName' in chunk && typeof (chunk as { toolName?: string }).toolName === 'string'
        ? (chunk as { toolName: string }).toolName
        : toolNameByCallId?.get(chunk.toolCallId);
    return name === 'PlanWrite' || name === 'Write';
  }
  return false;
}

/**
 * PlanWrite / Write(plan file) / ExitPlanMode stream as tool-input-start + deltas
 * before tool-input-available. Suppressing only the final available chunk leaves duplicate native UI.
 * Claude Code SDK uses `Write` for session plan `.md` files; `ExitPlanMode` also streams (must not reach IPC).
 */
export function shouldSuppressNativePlanStreamChunk(
  chunk: UIMessageChunk,
  suppressNativePlanTools: boolean,
  nativePlanStreamCallIds: Set<string>,
): boolean {
  if (!suppressNativePlanTools) return false;
  if (chunk.type === 'tool-input-start') {
    const name = chunk.toolName;
    if (
      name === 'PlanWrite' ||
      name === 'Write' ||
      name === 'ExitPlanMode' ||
      name === 'EnterPlanMode'
    ) {
      nativePlanStreamCallIds.add(chunk.toolCallId);
      return true;
    }
    return false;
  }
  if (chunk.type === 'tool-input-delta') {
    return nativePlanStreamCallIds.has(chunk.toolCallId);
  }
  return false;
}

export function shouldSuppressPlanTextChunk(
  chunk: UIMessageChunk,
  suppressPlanText: boolean,
): boolean {
  if (!suppressPlanText) return false;
  return chunk.type === 'text-start' || chunk.type === 'text-delta' || chunk.type === 'text-end';
}

/**
 * Hide plan-mode transition tool rows (EnterPlanMode / ExitPlanMode) in plan mode — the canonical
 * frink-plan card replaces them. EnterPlanMode is the model-initiated entry tool (mid-conversation
 * transition from agent to plan); ExitPlanMode is the model-initiated submit-for-approval tool.
 */
export function shouldSuppressExitPlanModeToolChunk(
  chunk: UIMessageChunk,
  suppressExitPlanModeTools: boolean,
  toolNameByCallId: Map<string, string>,
): boolean {
  if (!suppressExitPlanModeTools) return false;
  if (chunk.type === 'tool-input-available') {
    return chunk.toolName === 'ExitPlanMode' || chunk.toolName === 'EnterPlanMode';
  }
  if (chunk.type === 'tool-output-available') {
    const name = toolNameByCallId.get(chunk.toolCallId);
    return name === 'ExitPlanMode' || name === 'EnterPlanMode';
  }
  return false;
}

export type PlanModeSuppressionContext = {
  /** True once the ExitPlanMode tool output has arrived (the canonical frink-plan card was emitted). */
  planCompletedByExitPlanMode: boolean;
  /** True for a flow agent node with `autoApprove` (skipReview) — no human approval gate. */
  flowPlanAutoApprove: boolean;
  suppressNativePlanTools: boolean;
  suppressPlanText: boolean;
  toolNameByCallId: Map<string, string>;
  /** Mutable bookkeeping sets — mutated as a side effect (mirrors the inline stream-loop behaviour). */
  nativePlanStreamCallIds: Set<string>;
  suppressedPostPlanToolCallIds: Set<string>;
};

/**
 * Decide whether a plan-mode stream chunk is hidden from the renderer. Three regimes:
 *
 * 1. **Auto-approve, post-ExitPlanMode** — the plan card is emitted and there is no approval gate, so
 *    the SDK's in-turn implementation (Write/Edit/Bash/text) STREAMS; only the ExitPlanMode/EnterPlanMode
 *    tool rows are hidden (the card replaces them). This is the fix for the "implementation invisible
 *    until reload" bug — it must NOT route through `shouldSuppressNativePlanToolChunk` (which hides `Write`).
 * 2. **Non-auto, post-ExitPlanMode** — blanket-hide everything except `finish` until the user approves.
 * 3. **Plan drafting (pre-ExitPlanMode)** — dedupe native plan artifacts so the frink-plan card is the
 *    only visible plan surface.
 */
export function resolvePlanModeChunkSuppression(
  chunk: UIMessageChunk,
  ctx: PlanModeSuppressionContext,
): boolean {
  if (ctx.planCompletedByExitPlanMode && ctx.flowPlanAutoApprove) {
    return shouldSuppressExitPlanModeToolChunk(chunk, true, ctx.toolNameByCallId);
  }
  if (ctx.planCompletedByExitPlanMode && chunk.type !== 'finish') {
    if (chunk.type === 'tool-input-available') {
      ctx.suppressedPostPlanToolCallIds.add(chunk.toolCallId);
    }
    return true;
  }
  return (
    shouldSuppressNativePlanStreamChunk(
      chunk,
      ctx.suppressNativePlanTools,
      ctx.nativePlanStreamCallIds,
    ) ||
    shouldSuppressNativePlanToolChunk(chunk, ctx.suppressNativePlanTools, ctx.toolNameByCallId) ||
    shouldSuppressExitPlanModeToolChunk(chunk, true, ctx.toolNameByCallId) ||
    shouldSuppressPlanTextChunk(chunk, ctx.suppressPlanText)
  );
}
