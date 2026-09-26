import type { ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
import { claudeModelUsesAdaptiveThinking } from '../../../shared/lib/models';
import type { ExecutionSettings } from '../../../shared/types/execution';

/**
 * Maps Frink `ExecutionSettings` to Claude Agent SDK `thinking`.
 *
 * **Adaptive families (Fable 5 / Opus 4.7 / 4.8 / Sonnet 5):** only `thinking: { type: "adaptive" }`
 * is accepted; manual `enabled` + `budget_tokens` is rejected with a 400 ([adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)).
 * Membership is declared once per family in the catalog (`adaptiveThinking`) and read via
 * `claudeModelUsesAdaptiveThinking` — no allowlist to keep in sync here. `display` defaults to
 * `"omitted"` (empty streamed thinking blocks → blank Thought panel); `"summarized"` restores
 * visible reasoning. The SDK maps adaptive → `--thinking adaptive` on the Claude Code CLI —
 * requires a **recent** bundled binary (`bun run claude:download`, `resources/bin/VERSION` ≥ 2.1.111).
 *
 * **Opus 4.6 / Sonnet 4.6 / Haiku:** `enabled` + `budgetTokens` → `--max-thinking-tokens` (works on
 * older CLIs).
 */
export function buildClaudeSdkThinkingPartial(
  settings: Pick<ExecutionSettings, 'model' | 'maxThinkingTokens'> | undefined,
): { thinking?: ThinkingConfig } {
  const budget = settings?.maxThinkingTokens;
  if (budget == null || budget <= 0) {
    return {};
  }
  // `settings.model` is the resolved CLI value (e.g. `claude-sonnet-5`, `sonnet`).
  if (settings?.model != null && claudeModelUsesAdaptiveThinking(settings.model)) {
    return { thinking: { type: 'adaptive', display: 'summarized' } };
  }
  return { thinking: { type: 'enabled', budgetTokens: budget } };
}
