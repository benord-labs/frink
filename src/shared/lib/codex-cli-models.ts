/**
 * OpenAI Codex models for `codex app-server`: a picker id encodes model slug + reasoning effort.
 * Wire shape, effort ladder and slug provenance: docs/decisions/codex-fast-mode-consent.md.
 */

import type { CodexSpeed } from '../types/execution';

/** Reasoning effort sent to the app-server as the separate `reasoning_effort` field. */
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Service tier on the wire: `priority` is Fast, `ultrafast` is Ultrafast. `null` explicitly clears it. */
export type CodexServiceTier = 'priority' | 'ultrafast' | null;

export type CodexCliModel = {
  id: string;
  familyId: string;
  familyName: string;
  variantLabel: string;
  contextWindow: string;
  /** Model slug sent to the app-server as the `model` field (e.g. `gpt-5.5`). */
  cliValue: string;
  /** Sent to the app-server as the separate `reasoning_effort` field. */
  reasoningEffort: CodexReasoningEffort;
  /** The app-server's default tier — the picker's reset target. */
  effortDefault?: true;
};

/**
 * Single source of truth for the codex coding-model slugs + their picker family metadata.
 * `isDefault` seeds chats with no valid codex selection; persisted codex ids pass through untouched.
 */
export const CODEX_MODEL_SLUGS: {
  slug: string;
  familyId: string;
  familyName: string;
  isDefault?: boolean;
}[] = [
  { slug: 'gpt-6-astra', familyId: 'codex-6-astra', familyName: 'GPT-6 Astra', isDefault: true },
  { slug: 'gpt-6.1-sol', familyId: 'codex-6.1-sol', familyName: 'GPT-6.1 Sol' },
  { slug: 'gpt-6-sol', familyId: 'codex-6-sol', familyName: 'GPT-6 Sol' },
  { slug: 'gpt-6-luna', familyId: 'codex-6-luna', familyName: 'GPT-6 Luna' },
  { slug: 'gpt-5.6-sol', familyId: 'codex-5.6-sol', familyName: 'GPT-5.6 Sol' },
  { slug: 'gpt-5.6-terra', familyId: 'codex-5.6-terra', familyName: 'GPT-5.6 Terra' },
  { slug: 'gpt-5.6-luna', familyId: 'codex-5.6-luna', familyName: 'GPT-5.6 Luna' },
  { slug: 'gpt-5.5', familyId: 'codex-5.5', familyName: 'GPT-5.5' },
  { slug: 'gpt-5.4', familyId: 'codex-5.4', familyName: 'GPT-5.4' },
  { slug: 'gpt-5.4-mini', familyId: 'codex-5.4-mini', familyName: 'GPT-5.4 Mini' },
];

/** Effort ladder surfaced per coding model; `medium` is the app-server default. */
const CODEX_EFFORT_TIERS: { effort: CodexReasoningEffort; label: string; isDefault?: true }[] = [
  { effort: 'low', label: 'Low' },
  { effort: 'medium', label: 'Medium', isDefault: true },
  { effort: 'high', label: 'High' },
  { effort: 'xhigh', label: 'Extra High' },
];

/**
 * Model-speed multiplier advertised for ChatGPT-authenticated Codex Fast mode.
 *
 * Speed and credit use are separate axes: Fast is 1.5× model speed, while the ChatGPT credit
 * multiplier remains model-specific below. Verified against https://developers.openai.com/codex/speed
 * on 2026-08-20. API-key priority pricing follows the API pricing page instead.
 */
export const CODEX_FAST_SPEED_MULTIPLIER = 1.5;

/** Ultrafast is "up to 8x" GPT-6 Astra's standard speed. Verified 2026-09-29 against
 *  https://learn.chatgpt.com/docs/agent-configuration/speed */
export const CODEX_ULTRAFAST_SPEED_MULTIPLIER = 8;

/** ChatGPT credit multiplier per paid speed, keyed by model slug. Opt-in: an absent slug is never
 *  offered (or billed) that tier, and the UI discloses these same numbers. */
const CODEX_TIER_CREDITS: Record<Exclude<CodexSpeed, 'standard'>, Record<string, number>> = {
  fast: {
    'gpt-6-astra': 2.5,
    'gpt-6.1-sol': 2.5,
    'gpt-6-sol': 2.5,
    'gpt-6-luna': 2.5,
    'gpt-5.6-sol': 2.5,
    'gpt-5.6-terra': 2.5,
    'gpt-5.6-luna': 2.5,
    'gpt-5.5': 2.5,
    'gpt-5.4': 2,
    // gpt-5.4-mini advertises no service tiers — intentionally absent.
  },
  // Pro 500 and eligible Enterprise/Edu plans only; the app-server drops it for other accounts.
  ultrafast: { 'gpt-6-astra': 8 },
};

const WIRE_TIER = { standard: null, fast: 'priority', ultrafast: 'ultrafast' } as const;

const CODEX_CONTEXT_WINDOW = 'Large context (varies by account tier)';

/** Full list for the model picker; `cliValue` is the slug, `reasoningEffort` the separate field. */
function buildCodexCliModels(): CodexCliModel[] {
  const out: CodexCliModel[] = [];
  for (const m of CODEX_MODEL_SLUGS) {
    for (const t of CODEX_EFFORT_TIERS) {
      out.push({
        id: `codex-${m.slug}-${t.effort}`,
        familyId: m.familyId,
        familyName: m.familyName,
        variantLabel: t.label,
        contextWindow: CODEX_CONTEXT_WINDOW,
        cliValue: m.slug,
        reasoningEffort: t.effort,
        effortDefault: t.isDefault,
      });
    }
  }
  return out;
}

export const CODEX_CLI_MODELS: CodexCliModel[] = buildCodexCliModels();

/** Picker id new chats seed to: the default model's default (medium) effort tier. */
export const CODEX_DEFAULT_MODEL_ID: string = (() => {
  const def = CODEX_MODEL_SLUGS.find((m) => m.isDefault) ?? CODEX_MODEL_SLUGS[0];
  const tier = CODEX_EFFORT_TIERS.find((t) => t.isDefault) ?? CODEX_EFFORT_TIERS[0];
  return `codex-${def.slug}-${tier.effort}`;
})();

const CODEX_MODEL_BY_ID = new Map(CODEX_CLI_MODELS.map((m) => [m.id, m]));

/**
 * Credit multiplier to disclose on the Fast control for a picker id, or `null` when that model has
 * no priority tier. Returns `null` for Claude / unknown ids too (they miss the catalog),
 * so callers need no separate provider check before deciding whether to offer Fast.
 */
export function codexFastTierCredits(pickerId: string | undefined): number | null {
  return codexTierCredits(pickerId, 'fast');
}

/** Credit multiplier of `speed` for a picker id, or `null` when that model does not offer it. */
export function codexTierCredits(
  pickerId: string | undefined,
  speed: Exclude<CodexSpeed, 'standard'>,
): number | null {
  const slug = pickerId ? CODEX_MODEL_BY_ID.get(pickerId)?.cliValue : undefined;
  return (slug ? CODEX_TIER_CREDITS[speed][slug] : undefined) ?? null;
}

/**
 * Splits a codex picker id (e.g. `codex-gpt-5.3-codex-high`) into the fields the v2 app-server
 * wants: `model` (the slug, sent on thread/turn), `effort` (reasoning effort) and `serviceTier`.
 * The executor is the single conversion boundary — the picker id is stored/forwarded raw, then
 * resolved here right before `runCodexAgent`. An unknown or missing id falls back to
 * {@link CODEX_DEFAULT_MODEL_ID} (default slug + `medium`) so codex never crashes on a stale value.
 *
 * `serviceTier` is set only when a non-standard speed is requested AND the RESOLVED slug advertises
 * that tier — so a chat left on Fast while switching to a model without it degrades to standard instead
 * of asking the app-server for a tier it would strip. It is otherwise an explicit `null`, never
 * absent: the tier is thread-sticky, so omitting it would silently keep billing. This function is
 * the single support boundary; no caller should re-implement the check.
 */
export function resolveCodexCliModel(
  pickerId: string | undefined,
  speed?: CodexSpeed,
): {
  model: string;
  effort: CodexReasoningEffort;
  serviceTier: CodexServiceTier;
} {
  const m =
    (pickerId && CODEX_MODEL_BY_ID.get(pickerId)) || CODEX_MODEL_BY_ID.get(CODEX_DEFAULT_MODEL_ID);
  // CODEX_DEFAULT_MODEL_ID is always a real catalog id, so m is defined; assert for the type.
  if (!m) throw new Error('Codex default model id is not in the catalog');
  const supported = speed && speed !== 'standard' && CODEX_TIER_CREDITS[speed][m.cliValue];
  return {
    model: m.cliValue,
    effort: m.reasoningEffort,
    serviceTier: supported ? WIRE_TIER[speed] : null,
  };
}

// CODEX_MODEL_FAMILIES + CODEX_MODEL_ID_MAP are derived ONCE in ./models (their single
// home) — not re-derived here, to avoid drift.
