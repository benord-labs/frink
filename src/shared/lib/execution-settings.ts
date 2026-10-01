/** A chat's composer settings and the one place both desktop and main turn them into the
 *  `ExecutionSettings` a send carries. */
import type { CodexSpeed, ExecutionSettings } from '../types/execution';
import { codexFastTierCredits } from './codex-cli-models';
import {
  claudeModelRequires1M,
  getClaudeCliModel,
  getClaudeSdkEffort,
  getClaudeThinkingBudget,
  isClaudeUltraModel,
  supportsNativeAutoReview,
} from './models';

export type ExecutionAccountKind = 'claude-code' | 'codex';

export type ComposerSettings = {
  /** Raw picker id (effort tier included). Never normalized on store: an account flip must not
   *  destroy the other provider's choice. */
  modelId: string;
  autoMode: boolean;
  codexSpeed: CodexSpeed;
  /** Global, not per chat: one Thinking switch governs every Claude chat. */
  thinkingEnabled: boolean;
};

/** Defaults for a chat nobody has configured. Standard speed on purpose: Fast bills a credit multiplier. */
export const COMPOSER_DEFAULTS: ComposerSettings = {
  modelId: 'sonnet',
  autoMode: true,
  codexSpeed: 'standard',
  thinkingEnabled: true,
};

/** Stored per-chat values (NULL = never set) resolved against the defaults. */
export function resolveComposerSettings(
  row: { modelId?: string | null; autoMode?: boolean | null; codexSpeed?: CodexSpeed | null },
  thinkingEnabled: boolean | null | undefined,
): ComposerSettings {
  return {
    modelId: row.modelId ?? COMPOSER_DEFAULTS.modelId,
    autoMode: row.autoMode ?? COMPOSER_DEFAULTS.autoMode,
    codexSpeed: row.codexSpeed ?? COMPOSER_DEFAULTS.codexSpeed,
    thinkingEnabled: thinkingEnabled ?? COMPOSER_DEFAULTS.thinkingEnabled,
  };
}

/**
 * Maps a picker model id to the execution `settings.model` string (Claude Code: opus|sonnet|haiku;
 * Codex: picker id forwarded RAW).
 */
export function resolveExecutionModelCliString(
  accountType: ExecutionAccountKind,
  selectedModelId: string,
): string {
  if (accountType === 'codex') {
    // Forwarded RAW: resolveCodexCliModel is the single split point for slug + effort
    // (docs/decisions model-id-execution-namespace).
    return selectedModelId;
  }
  return getClaudeCliModel(selectedModelId);
}

/** The execution settings a send carries for these composer settings on this account. */
export function buildExecutionSettings(
  accountType: ExecutionAccountKind,
  settings: ComposerSettings,
  extra: { enableTasks?: boolean } = {},
): ExecutionSettings {
  const isClaude = accountType === 'claude-code';
  // Deliberately NOT normalized: a stale or cross-provider id must gate Fast off rather than snap to
  // a default whose tier bills a multiplier. Main's model resolution owns the fallback slug.
  const { modelId } = settings;
  // The thinking budget is Claude-Code-only: Codex carries its own reasoning_effort field.
  const maxThinkingTokens =
    isClaude && settings.thinkingEnabled ? (getClaudeThinkingBudget(modelId) ?? 32_000) : undefined;
  const effort = maxThinkingTokens != null ? getClaudeSdkEffort(modelId) : undefined;
  return {
    maxThinkingTokens,
    ...(effort && { effort }),
    // Ultra is orchestration, not reasoning depth, so it holds whether or not Thinking is on.
    ...(isClaude && isClaudeUltraModel(modelId) && { ultra: true }),
    model: resolveExecutionModelCliString(accountType, modelId),
    ...(extra.enableTasks !== undefined ? { enableTasks: extra.enableTasks } : {}),
    // Enable 1M context beta when a 1M model variant is selected (Claude SDK only)
    ...(isClaude && claudeModelRequires1M(modelId) && { betas: ['context-1m-2025-08-07'] }),
    // One Auto value governs every turn in the chat. Plan mode is not excluded: the executor
    // arms the reviewer at plan approval only if it knows the chat consented.
    ...(settings.autoMode && supportsNativeAutoReview(accountType, modelId)
      ? { autoReviewTools: true }
      : {}),
    // Gated on the model advertising the tier, so a chat left on Fast while switching to a model
    // without one sends nothing. `resolveCodexCliModel` re-checks in main.
    ...(codexFastTierCredits(modelId) !== null ? { codexSpeed: settings.codexSpeed } : {}),
  };
}
