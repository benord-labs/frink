import { LAUNCH_FLAGS } from '../../launch-flags';
import type { ClaudeSdkEffortLevel } from '../../types/execution';
import { CODEX_CLI_MODELS, CODEX_DEFAULT_MODEL_ID, type CodexCliModel } from '../codex-cli-models';
import {
  CLAUDE_CODE_MODELS_CATALOG,
  CLAUDE_ULTRA_SUFFIX,
  type ClaudeCodeModel,
} from './claude-catalog';

/**
 * Provider model derivations (picker rows, id → CLI map, family toggles, effort/thinking
 * resolution). The Claude catalog itself lives in `./claude-catalog`; Codex keeps its own
 * sibling catalog module. Re-exported here so `shared/lib/models` stays the single
 * import surface for every consumer.
 */
export { CLAUDE_CODE_MODELS_CATALOG, type ClaudeCodeModel };

/**
 * App-facing catalog: launch-flag-paused families removed. Every derived const + UI
 * picker below maps from this, so the single filter cascades everywhere. Fable 5 is
 * gated by `LAUNCH_FLAGS.fable5` (a kill-switch — Anthropic has pulled the model
 * before); flip it off to hide the family with no other change.
 */
export const CLAUDE_CODE_MODELS: ClaudeCodeModel[] = CLAUDE_CODE_MODELS_CATALOG.filter(
  (m) => LAUNCH_FLAGS.fable5 || m.familyId !== 'fable-5',
);

/** Claude Code model ids only (API accepts these; use for Claude Code account). */
export const CLAUDE_MODEL_IDS = CLAUDE_CODE_MODELS.map((m) => m.id);

/** Fallback Claude model when a selection is unknown or cross-provider (short alias, always valid). */
const CLAUDE_DEFAULT_MODEL = 'sonnet';

/**
 * CLI values whose family uses adaptive thinking — derived from the catalog so the SDK thinking
 * path has a single source of truth (no parallel allowlist to keep in sync). Uses the full
 * `_CATALOG` so a launch-flag-gated family (Fable 5) still resolves correctly if selected.
 */
const ADAPTIVE_THINKING_CLI_VALUES = new Set(
  CLAUDE_CODE_MODELS_CATALOG.filter((m) => m.adaptiveThinking).map((m) => m.cliValue),
);

/** Whether a resolved CLI model value must use adaptive thinking instead of a manual budget. */
export function claudeModelUsesAdaptiveThinking(cliValue: string): boolean {
  return ADAPTIVE_THINKING_CLI_VALUES.has(cliValue);
}

// ── Shared per-provider catalog derivations ──────────────────────────────────
// One helper apiece so the catalogs cannot drift; Claude's extra `version` is grafted on below.
type CatalogModel = {
  id: string;
  familyId: string;
  familyName: string;
  variantLabel: string;
  contextWindow: string;
  cliValue: string;
  effortDefault?: true;
  contextDefault?: true;
};
type ModelPickerItem = {
  id: string;
  name: string;
  detail?: string;
  familyId: string;
  contextLabel: string;
  effort?: ClaudeSdkEffortLevel;
  effortDefault?: true;
  contextDefault?: true;
  /** Claude Ultra twin of the same tier (see `ClaudeCodeModel.ultra`). */
  ultra?: true;
};

/** Deduped families for settings visibility (a family toggle hides the whole familyId). */
function modelFamilies(models: readonly CatalogModel[]): { id: string; name: string }[] {
  return Array.from(
    new Map(models.map((m) => [m.familyId, { id: m.familyId, name: m.familyName }])).values(),
  );
}

/** Picker id → CLI/slug value sent to the provider. */
function modelIdMap(models: readonly CatalogModel[]): Record<string, string> {
  return Object.fromEntries(models.map((m) => [m.id, m.cliValue]));
}

function isModelVisible(model: { familyId: string }, hiddenFamilyIds: string[]): boolean {
  return !hiddenFamilyIds.includes(model.familyId);
}

/** The common UI picker row shape shared by every provider catalog. */
function toModelPickerItem(
  m: CatalogModel,
  effort: ClaudeSdkEffortLevel | undefined,
): ModelPickerItem {
  return {
    id: m.id,
    name: m.familyName,
    detail: m.variantLabel || undefined,
    familyId: m.familyId,
    contextLabel: m.contextWindow,
    effort,
    effortDefault: m.effortDefault,
    contextDefault: m.contextDefault,
  };
}

/**
 * Deduped families for settings visibility (toggle hides whole familyId).
 * Each family is a single model+version (e.g. Opus 4.7 and Opus 4.6 are separate entries).
 */
export const CLAUDE_MODEL_FAMILIES = modelFamilies(CLAUDE_CODE_MODELS);

export function isClaudeModelVisible(model: ClaudeCodeModel, hiddenFamilyIds: string[]): boolean {
  return isModelVisible(model, hiddenFamilyIds);
}

export const CLAUDE_MODEL_ID_MAP: Record<string, string> = modelIdMap(CLAUDE_CODE_MODELS);

/**
 * Get the CLI model value (short alias or full model ID) for a model selection.
 * Unknown ids fall back to `'sonnet'` so the executor still has something valid to send.
 */
export function getClaudeCliModel(modelId: string): string {
  const model = CLAUDE_CODE_MODELS.find((m) => m.id === modelId);
  return model?.cliValue ?? CLAUDE_DEFAULT_MODEL;
}

const CLAUDE_AUTO_MODEL_VERSION_RE = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/;

function claudeModelSupportsNativeAutoReview(model: string): boolean {
  const normalized = model.toLowerCase();
  const version = CLAUDE_AUTO_MODEL_VERSION_RE.exec(normalized);
  // Picker ids, current aliases and forward models pass; `claude-3-*` ids predate Auto.
  if (!version) return !/^claude-\d/.test(normalized);
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 6);
}

/**
 * Whether the selected provider/model has a provider-owned AI approval reviewer.
 * Claude Auto excludes pre-4.6 models, Haiku 4.5 included.
 * Account/admin eligibility remains provider-owned and is reported at runtime.
 */
export function supportsNativeAutoReview(
  accountType: string,
  selectedModelId: unknown,
  options: { allowClaudeSdkDefault?: boolean } = {},
): boolean {
  if (accountType === 'codex') return true;
  if (accountType !== 'claude-code') return false;
  if (selectedModelId == null || selectedModelId === '') {
    return options.allowClaudeSdkDefault === true;
  }
  if (typeof selectedModelId !== 'string') return false;

  return [selectedModelId, getClaudeCliModel(selectedModelId)].every(
    claudeModelSupportsNativeAutoReview,
  );
}

/** Get the thinking token budget for a model (used when thinking toggle is ON). */
export function getClaudeThinkingBudget(modelId: string): number | undefined {
  const model = CLAUDE_CODE_MODELS.find((m) => m.id === modelId);
  return model?.maxThinkingTokens;
}

/** Picker id has Ultra on: the CLI's parallel-agent orchestration, at the tier's own effort. */
export function isClaudeUltraModel(modelId: string): boolean {
  return modelId.endsWith(CLAUDE_ULTRA_SUFFIX);
}

/**
 * Maps picker model id to Claude Agent SDK `effort` (adaptive thinking + Opus 4.7 / 4.8 / 5 tiers).
 * Default tier (no suffix) → `medium`, except Fable 5.1 / Fable 5 / Opus 5 / Opus 4.8 / Sonnet 5.5 / Sonnet 5 whose default is `high`.
 */
export function getClaudeSdkEffort(modelId: string): ClaudeSdkEffortLevel | undefined {
  if (isClaudeUltraModel(modelId)) {
    return getClaudeSdkEffort(modelId.slice(0, -CLAUDE_ULTRA_SUFFIX.length));
  }
  if (modelId.endsWith('-max')) return 'max';
  if (modelId.endsWith('-xhigh')) return 'xhigh';
  if (modelId.endsWith('-low')) return 'low';
  if (modelId.endsWith('-medium')) return 'medium';
  if (modelId.endsWith('-high')) return 'high';
  // Fable 5.1 / Fable 5 + Opus 5 + Opus 4.8 + Sonnet 5.5 / 5 default to High effort (bare id, no suffix); others to Medium.
  if (modelId.startsWith('fable-5')) return 'high';
  if (modelId.startsWith('opus-5.5')) return 'medium'; // before `opus-5`, which it also prefixes
  if (modelId.startsWith('opus-5')) return 'high';
  if (modelId.startsWith('opus-4.8')) return 'high';
  if (modelId.startsWith('sonnet-5')) return 'high'; // also covers `sonnet-5.5`
  if (
    modelId.startsWith('opus-4.7') ||
    modelId.startsWith('opus-') ||
    modelId.startsWith('sonnet') ||
    modelId.startsWith('haiku') // also covers `haiku-5.5`
  ) {
    return 'medium';
  }
  return undefined;
}

/** Whether a model ID requires the 1M context beta. */
export function claudeModelRequires1M(modelId: string): boolean {
  return modelId.includes('-1m');
}

export function claudeModelToPickerItem(m: ClaudeCodeModel): ModelPickerItem & { version: string } {
  return {
    ...toModelPickerItem(m, m.effort),
    version: m.pickerVersion,
    ...(m.ultra && { ultra: m.ultra }),
  };
}

/** UI picker rows for Claude Code models (same shape as `claudeModelToPickerItem`). */
export const CLAUDE_PICKER_MODELS = CLAUDE_CODE_MODELS.map(claudeModelToPickerItem);

/**
 * Coerce a picker model id to one valid for the resolved execution account (Codex / Claude).
 * Shared by `useModelNormalization` and new-chat seeding — keep catalog rules in one place. An account
 * switch (e.g. Claude → Codex) leaves a stale cross-provider id that must snap to that provider's default.
 */
export function normalizeModelIdForExecutionAccount(
  isCodexAccount: boolean,
  modelId: string,
): string {
  if (isCodexAccount) {
    return CODEX_MODELS.some((m) => m.id === modelId) ? modelId : CODEX_DEFAULT_MODEL_ID;
  }
  if (!CLAUDE_MODEL_IDS.includes(modelId)) return CLAUDE_DEFAULT_MODEL;
  return modelId;
}

/** Codex app-server models: model slug + separate reasoning-effort tier (see codex-cli-models). */
export const CODEX_MODELS: CodexCliModel[] = CODEX_CLI_MODELS;

/** Deduped families for settings visibility (toggle hides whole `familyId`). */
export const CODEX_MODEL_FAMILIES = modelFamilies(CODEX_MODELS);

/** Newest model of each line (the name minus its version, e.g. "Opus", "GPT- Sol") vs the rest. */
export function splitNewestFamilies<T extends { name: string }>(families: readonly T[]) {
  const seen = new Set<string>();
  const newest: T[] = [];
  const older: T[] = [];
  for (const family of families) {
    const line = family.name.replace(/\d+(?:\.\d+)*/g, '').trim();
    (seen.has(line) ? older : newest).push(family);
    seen.add(line);
  }
  return { newest, older };
}

export function isCodexModelVisible(model: CodexCliModel, hiddenFamilyIds: string[]): boolean {
  return isModelVisible(model, hiddenFamilyIds);
}

export const CODEX_MODEL_ID_MAP: Record<string, string> = modelIdMap(CODEX_MODELS);

export function codexModelToPickerItem(m: CodexCliModel): ModelPickerItem {
  return toModelPickerItem(m, m.reasoningEffort);
}
