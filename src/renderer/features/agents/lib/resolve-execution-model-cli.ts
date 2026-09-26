/**
 * Maps UI picker model ids to execution `settings.model` strings (Claude Code: opus|sonnet|haiku;
 * Codex: picker id forwarded RAW).
 */
import { getClaudeCliModel, supportsNativeAutoReview } from '../../../../shared/lib/models';

export type ExecutionAccountKind = 'claude-code' | 'codex';
export { supportsNativeAutoReview };

export function resolveExecutionModelCliString(
  accountType: ExecutionAccountKind,
  selectedModelId: string,
): string {
  if (accountType === 'codex') {
    // Codex's slug + turn-scoped effort can't survive a single-string resolution, so the picker id
    // is forwarded RAW; the executor (resolveCodexCliModel) is the single split point. See
    // docs/decisions model-id-execution-namespace (convert at one boundary).
    return selectedModelId;
  }
  return getClaudeCliModel(selectedModelId);
}
