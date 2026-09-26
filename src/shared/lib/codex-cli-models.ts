/**
 * OpenAI Codex models for `codex app-server`: a picker id encodes model slug + reasoning effort.
 * Wire shape, effort ladder and slug provenance: docs/decisions/codex-fast-mode-consent.md.
 */

/** Reasoning effort sent to the app-server as the separate `reasoning_effort` field. */
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Value of the `priority` ("Fast") service tier on the wire. `null` explicitly clears it. */
export type CodexServiceTier = 'priority' | null;

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

/**
 * ChatGPT credit multiplier charged by the `priority` ("Fast") service tier, keyed by model slug.
 *
 * A slug ABSENT from this map has no priority tier and must never be offered Fast — the mapping is
 * deliberately opt-in so a newly added model cannot silently start offering, or billing for, a tier
 * it does not advertise. Doubles as the source of the number disclosed in the UI, so the gate and
 * the label can never drift apart.
 */
const CODEX_FAST_TIER_CREDITS: Record<string, number> = {
  'gpt-6-astra': 2.5,
  'gpt-6-sol': 2.5,
  'gpt-6-luna': 2.5,
  'gpt-5.6-sol': 2.5,
  'gpt-5.6-terra': 2.5,
  'gpt-5.6-luna': 2.5,
  'gpt-5.5': 2.5,
  'gpt-5.4': 2,
  // gpt-5.4-mini advertises no service tiers — intentionally absent.
};

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
  const slug = pickerId ? CODEX_MODEL_BY_ID.get(pickerId)?.cliValue : undefined;
  return (slug ? CODEX_FAST_TIER_CREDITS[slug] : undefined) ?? null;
}

/**
 * Splits a codex picker id (e.g. `codex-gpt-5.3-codex-high`) into the fields the v2 app-server
 * wants: `model` (the slug, sent on thread/turn), `effort` (reasoning effort) and `serviceTier`.
 * The executor is the single conversion boundary — the picker id is stored/forwarded raw, then
 * resolved here right before `runCodexAgent`. An unknown or missing id falls back to
 * {@link CODEX_DEFAULT_MODEL_ID} (default slug + `medium`) so codex never crashes on a stale value.
 *
 * `serviceTier` is `'priority'` only when Fast is requested AND the RESOLVED slug advertises the
 * tier — so a chat left on Fast while switching to a model without it degrades to standard instead
 * of asking the app-server for a tier it would strip. It is otherwise an explicit `null`, never
 * absent: the tier is thread-sticky, so omitting it would silently keep billing. This function is
 * the single support boundary; no caller should re-implement the check.
 */
export function resolveCodexCliModel(
  pickerId: string | undefined,
  fastMode?: boolean,
): {
  model: string;
  effort: CodexReasoningEffort;
  serviceTier: CodexServiceTier;
} {
  const m =
    (pickerId && CODEX_MODEL_BY_ID.get(pickerId)) || CODEX_MODEL_BY_ID.get(CODEX_DEFAULT_MODEL_ID);
  // CODEX_DEFAULT_MODEL_ID is always a real catalog id, so m is defined; assert for the type.
  if (!m) throw new Error('Codex default model id is not in the catalog');
  const supportsFast = CODEX_FAST_TIER_CREDITS[m.cliValue] !== undefined;
  return {
    model: m.cliValue,
    effort: m.reasoningEffort,
    serviceTier: fastMode && supportsFast ? 'priority' : null,
  };
}

// CODEX_MODEL_FAMILIES + CODEX_MODEL_ID_MAP are derived ONCE in ./models (their single
// home) — not re-derived here, to avoid drift.
