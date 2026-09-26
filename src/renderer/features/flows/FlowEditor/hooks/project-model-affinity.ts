/**
 * Claude vs Codex model id compatibility for flow/trigger UI (no tRPC — safe for unit tests).
 */

/** Prefix for model ids that map to the OpenAI Codex provider (vs Anthropic). */
export const CODEX_MODEL_PREFIX = 'codex-';

/** Resolved execution backend for a project, or unknown when no project / still loading / null account. */
export type FlowProjectExecutionKind = 'claude-code' | 'codex' | 'unknown';

/**
 * True when a persisted model id carries the other provider's namespace. A `true` clears the saved
 * override, so this stays a deny-list: an id this build simply doesn't recognise is left alone.
 */
export function isFlowModelIncompatibleWithProjectProvider(
  model: string | undefined | null,
  projectProvider: FlowProjectExecutionKind,
): boolean {
  if (projectProvider === 'unknown') return false;
  if (model == null || typeof model !== 'string' || model.trim() === '') return false;
  const isCodexModelId = model.startsWith(CODEX_MODEL_PREFIX);
  return projectProvider === 'codex' ? !isCodexModelId : isCodexModelId;
}
