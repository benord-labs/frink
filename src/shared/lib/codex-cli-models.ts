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

/** Paid speeds the signed-in account can use, keyed by model slug, as Codex's `model/list` reports. */
export type CodexAccountTiers = Record<string, Exclude<CodexSpeed, 'standard'>[]>;

/** The signed-in account's own `model/list`: `tiers` has one key per model it lists. */
export type CodexAccountCatalog = { tiers: CodexAccountTiers; defaultSlug: string | null };

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

/** Frink's models the account lists, or `null` when that is unknown (no catalog, or no overlap). */
function accountModels(catalog: CodexAccountCatalog | null | undefined): CodexCliModel[] | null {
  if (!catalog) return null;
  const listed = CODEX_CLI_MODELS.filter((m) => m.cliValue in catalog.tiers);
  return listed.length > 0 ? listed : null;
}

/** Picker rows for the signed-in account; the full static list while its catalog is unknown. */
export function codexModelsForAccount(
  catalog: CodexAccountCatalog | null | undefined,
): CodexCliModel[] {
  return accountModels(catalog) ?? CODEX_CLI_MODELS;
}

/** The id a chat with no usable Codex model starts on: the account's own default when Frink knows
 *  it, else the first Frink model it lists, at the default effort. */
export function codexDefaultModelIdForAccount(
  catalog: CodexAccountCatalog | null | undefined,
): string {
  const listed = accountModels(catalog);
  if (!listed) return CODEX_DEFAULT_MODEL_ID;
  const slug =
    listed.find((m) => m.cliValue === catalog?.defaultSlug)?.cliValue ?? listed[0].cliValue;
  const effort = CODEX_EFFORT_TIERS.find((t) => t.isDefault)?.effort ?? 'medium';
  return `codex-${slug}-${effort}`;
}

/** A Codex model Frink knows that the signed-in account's catalog does not list. */
export function isCodexModelUnavailable(
  pickerId: string | undefined,
  catalog: CodexAccountCatalog | null | undefined,
): boolean {
  const model = pickerId ? CODEX_MODEL_BY_ID.get(pickerId) : undefined;
  const listed = accountModels(catalog);
  return Boolean(model && listed && !listed.includes(model));
}

/** A send on a model the account cannot use, worded for the person who picked it. */
export class CodexModelUnavailableError extends Error {
  constructor(familyName: string) {
    super(
      `${familyName} isn't available on your ChatGPT plan. Pick another model from the model menu.`,
    );
    this.name = 'CodexModelUnavailableError';
  }
}

/**
 * Credit multiplier to disclose on the Fast control for a picker id, or `null` when that model has
 * no priority tier. Returns `null` for Claude / unknown ids too (they miss the catalog),
 * so callers need no separate provider check before deciding whether to offer Fast.
 */
export function codexFastTierCredits(pickerId: string | undefined): number | null {
  return codexTierCredits(pickerId, 'fast');
}

/** Credit multiplier of `speed` for a picker id, or `null` when that model does not offer it —
 *  or, given `accountTiers`, when the signed-in account cannot use it on that model. */
export function codexTierCredits(
  pickerId: string | undefined,
  speed: Exclude<CodexSpeed, 'standard'>,
  accountTiers?: CodexAccountTiers,
): number | null {
  const slug = pickerId ? CODEX_MODEL_BY_ID.get(pickerId)?.cliValue : undefined;
  if (!slug || (accountTiers && !accountTiers[slug]?.includes(speed))) return null;
  return CODEX_TIER_CREDITS[speed][slug] ?? null;
}

/**
 * Splits a codex picker id (e.g. `codex-gpt-5.3-codex-high`) into the fields the v2 app-server
 * wants: `model` (the slug, sent on thread/turn), `effort` (reasoning effort) and `serviceTier`.
 * The executor is the single conversion boundary — the picker id is stored/forwarded raw, then
 * resolved here right before `runCodexAgent`. An unknown or missing id falls back to
 * the account's default so codex never crashes on a stale value; a model it lacks throws instead.
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
  catalog?: CodexAccountCatalog | null,
): {
  model: string;
  effort: CodexReasoningEffort;
  serviceTier: CodexServiceTier;
} {
  const m =
    (pickerId && CODEX_MODEL_BY_ID.get(pickerId)) ||
    CODEX_MODEL_BY_ID.get(codexDefaultModelIdForAccount(catalog));
  // The account default is always a real catalog id, so m is defined; assert for the type.
  if (!m) throw new Error('Codex default model id is not in the catalog');
  if (isCodexModelUnavailable(m.id, catalog)) throw new CodexModelUnavailableError(m.familyName);
  const supported = speed && speed !== 'standard' && CODEX_TIER_CREDITS[speed][m.cliValue];
  return {
    model: m.cliValue,
    effort: m.reasoningEffort,
    serviceTier: supported ? WIRE_TIER[speed] : null,
  };
}

// CODEX_MODEL_FAMILIES + CODEX_MODEL_ID_MAP are derived ONCE in ./models (their single
// home) — not re-derived here, to avoid drift.
