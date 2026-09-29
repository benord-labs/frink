/**
 * Claude Code model catalog (UI + id → CLI mapping).
 *
 * **Execution values:** each `cliValue` is either a short alias (`haiku` | `sonnet` |
 * `opus`) or a version-pinned Anthropic model ID (`claude-opus-4-8`, `claude-sonnet-5`, …)
 * when the SDK's baked-in prompt must reflect a specific version — see `VALID_MODELS` in
 * [`src/shared/types/execution.ts`](../types/execution.ts) and
 * `settings?.model` gating in `src/main/lib/socket/executor.ts`.
 *
 * Context tiers (200k vs 1M) and thinking variants are picker-level rows
 * grouped under the same family. All variants resolve to the same CLI value.
 */
import type { PickerEffortLevel } from '../../types/execution';

export type ClaudeCodeModel = {
  id: string;
  familyId: string;
  familyName: string;
  variantLabel: string;
  contextWindow: string;
  /**
   * Value forwarded to the Claude Agent SDK as `model`. Either a short alias
   * (`opus` | `sonnet` | `haiku`) or a full Anthropic model ID
   * (e.g. `claude-opus-4-7`, `claude-opus-4-6`) when we need to pin a specific
   * version so the SDK's baked-in system prompt reflects the right model.
   */
  cliValue: string;
  /** Shown next to the family in the grouped picker. */
  pickerVersion: string;
  /** Thinking token budget used when the thinking toggle is ON. */
  maxThinkingTokens?: number;
  /** Effort tier this variant runs at; the picker's slider ranks and groups by it. */
  effort?: PickerEffortLevel;
  /** The family's default tier (the bare id) — the picker's reset target. */
  effortDefault?: true;
  /** The family's default context window — where the picker lands when this family is chosen. */
  contextDefault?: true;
  /**
   * Family uses adaptive thinking: when thinking is ON the SDK must send
   * `thinking: { type: 'adaptive' }`, not a manual `budget_tokens` (rejected with 400).
   * Consumed by `claudeModelUsesAdaptiveThinking` — the single source of truth for the
   * SDK thinking path (no parallel allowlist).
   */
  adaptiveThinking?: true;
};

// ── Thinking effort budgets ─────────────────────────────────────────
// Thinking on/off is controlled by the global toggle, NOT by model variants.
// The effort tier sets the budget WHEN thinking is enabled.
const EFFORT_LOW = 10_000;
const EFFORT_MEDIUM = 32_000; // Default — "Medium" uses this.
const EFFORT_HIGH = 60_000; // Under 64k to stay within all models' max_tokens cap.
const EFFORT_XHIGH = 62_000; // "Extra High" — between High and Max; nominal (xhigh families are adaptive, budget ignored).
const EFFORT_MAX = 63_000; // Opus "Max" tier — still under 64k max_tokens cap.

type EffortTier = {
  suffix: string;
  label: string;
  effort: PickerEffortLevel;
  budget: number;
  isDefault?: true;
};

/** Default effort is "Medium" (empty suffix) — matches Cursor's effort-tier naming. */
const DEFAULT_EFFORTS: EffortTier[] = [
  { suffix: '', label: 'Medium', effort: 'medium', budget: EFFORT_MEDIUM, isDefault: true },
  { suffix: '-low', label: 'Low', effort: 'low', budget: EFFORT_LOW },
  { suffix: '-high', label: 'High', effort: 'high', budget: EFFORT_HIGH },
];

// `xhigh` and `max` are the top tiers (the bundled CLI accepts `low|medium|high|xhigh|max`).
// Only Fable 5.1 / Fable 5 / Opus 5.5 / 5 / 4.8 / 4.7 / Sonnet 5.5 / 5 support them — the SDK silently downgrades elsewhere.
const XHIGH_TIER: EffortTier = {
  suffix: '-xhigh',
  label: 'Extra High',
  effort: 'xhigh',
  budget: EFFORT_XHIGH,
};

// Ultra = `xhigh` plus the CLI's parallel-agent orchestration (`settings.ultracode`), so it rides
// only the ladders that offer xhigh. Why: docs/decisions/ultra-effort-tier.md
const ULTRA_TIER: EffortTier = {
  suffix: '-ultra',
  label: 'Ultra',
  effort: 'ultra',
  budget: EFFORT_XHIGH,
};

// Medium-default full ladder (Opus 4.7, Opus 5.5).
const OPUS_47_EFFORTS: EffortTier[] = [
  ...DEFAULT_EFFORTS,
  XHIGH_TIER,
  { suffix: '-max', label: 'Max', effort: 'max', budget: EFFORT_MAX },
  ULTRA_TIER,
];

// High-default families (Fable 5.1, Fable 5, Opus 5, Opus 4.8, Sonnet 5.5, Sonnet 5) — Anthropic sets `effort: high` as the API
// default and all support the full ladder. Bare row (no suffix) is High; Low / Medium / Extra High /
// Max explicit.
const HIGH_DEFAULT_EFFORTS: EffortTier[] = [
  { suffix: '', label: 'High', effort: 'high', budget: EFFORT_HIGH, isDefault: true },
  { suffix: '-low', label: 'Low', effort: 'low', budget: EFFORT_LOW },
  { suffix: '-medium', label: 'Medium', effort: 'medium', budget: EFFORT_MEDIUM },
  XHIGH_TIER,
  { suffix: '-max', label: 'Max', effort: 'max', budget: EFFORT_MAX },
  ULTRA_TIER,
];

type ContextTier = { suffix: string; ctx: string; prefix: string; isDefault?: true };

/**
 * Default context rows: 200k + 1M, with 1M the picker's default. Override per family (e.g. Opus 4.8
 * is 1M-native, single row). Ids are unchanged: the bare id stays 200k so saved selections resolve.
 */
const DEFAULT_CONTEXTS: ContextTier[] = [
  { suffix: '', ctx: '200k context', prefix: '' },
  { suffix: '-1m', ctx: '1M context', prefix: '1M', isDefault: true },
];

/**
 * Build context × effort variants for an Opus/Sonnet family.
 *
 * Produces C (contexts) × N (efforts) variants. With default contexts + efforts that's 6:
 *   Medium (200k) · Low (200k) · High (200k)
 *   1M · Medium · 1M · Low · 1M · High
 * Opus 4.7 also includes the "Max" tier in both context windows. Opus 4.8 overrides
 * `contexts` to a single 1M row (1M-native) and defaults its bare row to High effort.
 *
 * `idPrefix` lets multiple versions of the same family (e.g. Opus 4.6 and 4.7)
 * coexist by disambiguating ids (`opus-*` vs `opus-4.7-*`) while sharing
 * `familyId: base` so settings toggles hide the whole Opus family.
 *
 * Thinking on/off is handled by the global toggle, not by model selection.
 */
type FamilyConfig = {
  base: 'opus' | 'sonnet';
  familyId: string;
  familyName: string;
  version: string;
  /** Value sent to the Claude Agent SDK — full model ID when pinning a version. */
  cliValue: string;
  efforts?: EffortTier[];
  /** Prefix for generated variant ids; defaults to `familyId`. */
  idPrefix?: string;
  /** Context-window rows; defaults to 200k + 1M. Single 1M row for 1M-native families (Opus 4.8). */
  contexts?: ContextTier[];
  /** Family uses adaptive thinking (see `ClaudeCodeModel.adaptiveThinking`). */
  adaptiveThinking?: true;
};

function buildFamily(cfg: FamilyConfig): ClaudeCodeModel[] {
  const efforts = cfg.efforts ?? DEFAULT_EFFORTS;
  const idPrefix = cfg.idPrefix ?? cfg.familyId;
  const contexts = cfg.contexts ?? DEFAULT_CONTEXTS;
  const defaultLabel = efforts.find((e) => e.isDefault)?.label ?? 'Medium';

  const out: ClaudeCodeModel[] = [];
  for (const c of contexts) {
    for (const e of efforts) {
      const variantParts = [c.prefix, e.isDefault ? '' : e.label].filter(Boolean);
      out.push({
        id: `${idPrefix}${c.suffix}${e.suffix}`,
        familyId: cfg.familyId,
        familyName: cfg.familyName,
        variantLabel: variantParts.length ? variantParts.join(' · ') : defaultLabel,
        contextWindow: c.ctx,
        cliValue: cfg.cliValue,
        pickerVersion: cfg.version,
        maxThinkingTokens: e.budget,
        effort: e.effort,
        effortDefault: e.isDefault,
        contextDefault: c.isDefault,
        ...(cfg.adaptiveThinking && { adaptiveThinking: true as const }),
      });
    }
  }
  return out;
}

/**
 * Full catalog including launch-flag-paused families (definition source of truth).
 * The app consumes the filtered `CLAUDE_CODE_MODELS` below — this stays complete so
 * the dormant Fable 5 definition is preserved and validated for a one-flag re-enable.
 */
export const CLAUDE_CODE_MODELS_CATALOG: ClaudeCodeModel[] = [
  // ── Fable 5.1 ── successor to Fable 5 at the same price; 1M native (no beta), adaptive thinking, High default.
  ...buildFamily({
    base: 'opus',
    familyId: 'fable-5.1',
    familyName: 'Fable 5.1',
    version: '5.1',
    cliValue: 'claude-fable-5-1',
    efforts: HIGH_DEFAULT_EFFORTS,
    idPrefix: 'fable-5.1',
    contexts: [{ suffix: '', ctx: '1M context', prefix: '' }],
    adaptiveThinking: true,
  }),
  // ── Fable 5 ──────────────────────────────────────────────────────────
  // Released 2026-06-09 — most capable Claude model; 200k + 1M context rows use the
  // existing -1m beta-header path (claudeModelRequires1M) until native-1M is confirmed.
  // Docs confirm Opus-4.8 effort parity: full ladder incl. Max, `effort: high` API default.
  ...buildFamily({
    base: 'opus',
    familyId: 'fable-5',
    familyName: 'Fable 5',
    version: '5',
    cliValue: 'claude-fable-5',
    efforts: HIGH_DEFAULT_EFFORTS,
    idPrefix: 'fable-5',
    adaptiveThinking: true,
  }),
  // ── Opus 5.5 ── 1M native; adaptive thinking is always on (cannot be disabled).
  // Unlike Opus 5, the API's `effort` default is Medium, so the bare row is Medium.
  ...buildFamily({
    base: 'opus',
    familyId: 'opus-5.5',
    familyName: 'Opus 5.5',
    version: '5.5',
    cliValue: 'claude-opus-5-5',
    efforts: OPUS_47_EFFORTS,
    idPrefix: 'opus-5.5',
    contexts: [{ suffix: '', ctx: '1M context', prefix: '' }],
    adaptiveThinking: true,
  }),
  // ── Opus 5 ───────────────────────────────────────────────────────────
  // Successor to Opus 4.8 at the same price. 1M context is native (default and maximum,
  // no beta header), thinking is adaptive and on by default, `effort` defaults to High
  // and supports the full ladder. cliValue pins the full model ID so the SDK's baked-in
  // system prompt reflects "Opus 5".
  ...buildFamily({
    base: 'opus',
    familyId: 'opus-5',
    familyName: 'Opus 5',
    version: '5',
    cliValue: 'claude-opus-5',
    efforts: HIGH_DEFAULT_EFFORTS,
    idPrefix: 'opus-5',
    contexts: [{ suffix: '', ctx: '1M context', prefix: '' }],
    adaptiveThinking: true,
  }),
  // ── Opus 4.8 ─────────────────────────────────────────────────────────
  // Released 2026-05-28 — Anthropic's most capable model. 1M context is native (no beta),
  // adaptive thinking, and `effort` defaults to High. Listed first so it surfaces at the top
  // of the picker. cliValue pins the full model ID so the SDK's baked-in prompt says "Opus 4.8".
  ...buildFamily({
    base: 'opus',
    familyId: 'opus-4.8',
    familyName: 'Opus 4.8',
    version: '4.8',
    cliValue: 'claude-opus-4-8',
    efforts: HIGH_DEFAULT_EFFORTS,
    idPrefix: 'opus-4.8',
    contexts: [{ suffix: '', ctx: '1M context', prefix: '' }],
    adaptiveThinking: true,
  }),
  // ── Opus 4.7 ─────────────────────────────────────────────────────────
  // Released 2026-04-16 — notable SWE gains over 4.6, adds the Max effort tier.
  // cliValue pins the full model ID so the SDK's baked-in system prompt says "Opus 4.7".
  ...buildFamily({
    base: 'opus',
    familyId: 'opus-4.7',
    familyName: 'Opus 4.7',
    version: '4.7',
    cliValue: 'claude-opus-4-7',
    efforts: OPUS_47_EFFORTS,
    idPrefix: 'opus-4.7',
    adaptiveThinking: true,
  }),
  // ── Opus 4.6 ─────────────────────────────────────────────────────────
  // Previous Opus generation; legacy id scheme (`opus`, `opus-low`, …) preserved
  // so saved user selections keep resolving after 4.7 was added.
  ...buildFamily({
    base: 'opus',
    familyId: 'opus-4.6',
    familyName: 'Opus 4.6',
    version: '4.6',
    cliValue: 'claude-opus-4-6',
    idPrefix: 'opus',
  }),
  // ── Sonnet 5.5 ── successor to Sonnet 5 at the same price; 1M native, adaptive thinking,
  // High default with the full ladder. Needs Claude Code CLI ≥ 2.1.284.
  ...buildFamily({
    base: 'sonnet',
    familyId: 'sonnet-5.5',
    familyName: 'Sonnet 5.5',
    version: '5.5',
    cliValue: 'claude-sonnet-5-5',
    efforts: HIGH_DEFAULT_EFFORTS,
    idPrefix: 'sonnet-5.5',
    contexts: [{ suffix: '', ctx: '1M context', prefix: '' }],
    adaptiveThinking: true,
  }),
  // ── Sonnet 5 ─────────────────────────────────────────────────────────
  // Drop-in over Sonnet 4.6. 1M context is native (default + max, no 200k variant, no beta —
  // mirrors Opus 4.8), adaptive thinking on by default, `effort` defaults to High and supports the
  // full ladder (Low / Medium / High / Extra High / Max). cliValue pins the full model ID so the
  // SDK's baked-in system prompt reflects "Sonnet 5".
  ...buildFamily({
    base: 'sonnet',
    familyId: 'sonnet-5',
    familyName: 'Sonnet 5',
    version: '5',
    cliValue: 'claude-sonnet-5',
    efforts: HIGH_DEFAULT_EFFORTS,
    idPrefix: 'sonnet-5',
    contexts: [{ suffix: '', ctx: '1M context', prefix: '' }],
    adaptiveThinking: true,
  }),
  // ── Sonnet 4.6 ───────────────────────────────────────────────────────
  ...buildFamily({
    base: 'sonnet',
    familyId: 'sonnet',
    familyName: 'Sonnet 4.6',
    version: '4.6',
    cliValue: 'sonnet',
  }),
  // ── Haiku 4.5 ────────────────────────────────────────────────────────
  {
    id: 'haiku',
    familyId: 'haiku',
    familyName: 'Haiku 4.5',
    variantLabel: '',
    contextWindow: '200k context',
    cliValue: 'haiku',
    pickerVersion: '4.5',
  },
];
