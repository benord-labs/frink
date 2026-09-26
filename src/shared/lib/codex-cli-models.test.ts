import { describe, expect, it } from 'vitest';
import {
  CODEX_CLI_MODELS,
  CODEX_DEFAULT_MODEL_ID,
  CODEX_FAST_SPEED_MULTIPLIER,
  CODEX_MODEL_SLUGS,
  type CodexReasoningEffort,
  codexFastTierCredits,
  resolveCodexCliModel,
} from './codex-cli-models';

describe('CODEX_CLI_MODELS (codex-specific data rules)', () => {
  // Generic catalog integrity (no-dup ids, cliValue present, id→slug map, family dedup)
  // is covered for codex in models.test.ts; these are the
  // codex-only rules (effort ladder, service tier, slug source-of-truth).
  it('cliValue is always one of the source-of-truth slugs', () => {
    const slugs = new Set(CODEX_MODEL_SLUGS.map((m) => m.slug));
    for (const m of CODEX_CLI_MODELS) {
      expect(slugs.has(m.cliValue), `${m.id} → ${m.cliValue}`).toBe(true);
    }
  });

  it('surfaces exactly the low/medium/high/xhigh ladder', () => {
    // Upstream types reasoning effort as an open string, so nothing but this pins the surfaced set:
    // a tier added to the ladder without a deliberate picker change shows up here.
    expect(new Set(CODEX_CLI_MODELS.map((m) => m.reasoningEffort))).toEqual(
      new Set<CodexReasoningEffort>(['low', 'medium', 'high', 'xhigh']),
    );
  });

  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    '%s exposes every supported picker effort',
    (slug) => {
      expect(
        CODEX_CLI_MODELS.filter((model) => model.cliValue === slug).map(
          (model) => model.reasoningEffort,
        ),
      ).toEqual<CodexReasoningEffort[]>(['low', 'medium', 'high', 'xhigh']);
    },
  );
});

describe('CODEX_MODEL_SLUGS', () => {
  it('has no duplicate slugs or family ids', () => {
    const slugs = CODEX_MODEL_SLUGS.map((m) => m.slug);
    const families = CODEX_MODEL_SLUGS.map((m) => m.familyId);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(families).size).toBe(families.length);
  });

  it('marks exactly one default model', () => {
    expect(CODEX_MODEL_SLUGS.filter((m) => m.isDefault).length).toBe(1);
  });

  it('lists the GPT-6 family first while retaining the GPT-5.x families', () => {
    expect(CODEX_MODEL_SLUGS.map((m) => m.slug)).toEqual([
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('uses GPT-6 Astra as the current Codex default', () => {
    const def = CODEX_MODEL_SLUGS.find((m) => m.isDefault);
    expect(def?.slug).toBe('gpt-6-astra');
  });
});

describe('CODEX_DEFAULT_MODEL_ID', () => {
  it('resolves to a real catalog id on the default slug at medium effort', () => {
    const model = CODEX_CLI_MODELS.find((m) => m.id === CODEX_DEFAULT_MODEL_ID);
    expect(model).toBeDefined();
    expect(CODEX_DEFAULT_MODEL_ID).toBe('codex-gpt-6-astra-medium');
    expect(model?.cliValue).toBe('gpt-6-astra');
    expect(model?.reasoningEffort).toBe('medium');
  });
});

describe('resolveCodexCliModel', () => {
  it('splits a picker id into the slug (model) + effort', () => {
    expect(resolveCodexCliModel('codex-gpt-5.6-sol-high')).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high',
      serviceTier: null,
    });
    expect(resolveCodexCliModel('codex-gpt-5.6-terra-low')).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'low',
      serviceTier: null,
    });
    expect(resolveCodexCliModel('codex-gpt-5.6-luna-xhigh')).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
      serviceTier: null,
    });
  });

  it('round-trips every catalog id back to its own slug + effort', () => {
    for (const m of CODEX_CLI_MODELS) {
      expect(resolveCodexCliModel(m.id)).toEqual({
        model: m.cliValue,
        effort: m.reasoningEffort,
        serviceTier: null,
      });
    }
  });

  it('falls back to the default slug + medium effort for unknown / bare-slug / missing ids', () => {
    const fallback = { model: 'gpt-6-astra', effort: 'medium', serviceTier: null };
    expect(resolveCodexCliModel('totally-unknown-model')).toEqual(fallback);
    // A bare slug is not a picker id (no effort suffix) → default, never a crash.
    expect(resolveCodexCliModel('gpt-5.6-terra')).toEqual(fallback);
    expect(resolveCodexCliModel(undefined)).toEqual(fallback);
    expect(resolveCodexCliModel('')).toEqual(fallback);
  });

  it('migrates a pre-change persisted codex id (gpt-5.3-codex) to the current default', () => {
    // A user who had `codex-gpt-5.3-codex-high` selected before the gpt-5.3→gpt-5.6 slug change:
    // the dropped id misses the catalog Map and recovers to the current default — never a crash
    // or a backend-rejected stale slug.
    expect(resolveCodexCliModel('codex-gpt-5.3-codex-high')).toEqual({
      model: 'gpt-6-astra',
      effort: 'medium',
      serviceTier: null,
    });
  });

  it('requests the priority tier only when Fast is on AND the model advertises it', () => {
    expect(resolveCodexCliModel('codex-gpt-5.6-sol-high', true).serviceTier).toBe('priority');
    expect(resolveCodexCliModel('codex-gpt-5.6-sol-high', false).serviceTier).toBeNull();
    expect(resolveCodexCliModel('codex-gpt-6-luna-high', true)).toEqual({
      model: 'gpt-6-luna',
      effort: 'high',
      serviceTier: 'priority',
    });
    // Fast left on while switching to a model with no tier must degrade, not ask for a tier the
    // app-server would strip.
    expect(resolveCodexCliModel('codex-gpt-5.4-mini-high', true).serviceTier).toBeNull();
  });

  it('never omits serviceTier — the tier is thread-sticky, so OFF must be an explicit null', () => {
    // Guards the whole feature: an absent key means "leave unchanged" on the app-server, which
    // would keep billing the priority tier after the user switches Fast off.
    for (const fastMode of [undefined, false, true]) {
      expect(resolveCodexCliModel('codex-gpt-5.4-mini-low', fastMode)).toHaveProperty(
        'serviceTier',
      );
    }
  });

  it('honours Fast on a stale id by falling back to a model that supports it', () => {
    // The fallback slug (astra) does advertise the tier, so a flow forwarding a dropped id still
    // gets the tier it asked for rather than a silent downgrade.
    expect(resolveCodexCliModel('codex-gpt-5.3-codex-high', true).serviceTier).toBe('priority');
  });
});

describe('codexFastTierCredits', () => {
  it('keeps the advertised speed separate from model-specific ChatGPT credit use', () => {
    expect(CODEX_FAST_SPEED_MULTIPLIER).toBe(1.5);
    expect(codexFastTierCredits('codex-gpt-5.6-sol-medium')).toBe(2.5);
    expect(codexFastTierCredits('codex-gpt-5.4-medium')).toBe(2);
  });

  it('returns the disclosed multiplier for every model that advertises the tier', () => {
    expect(codexFastTierCredits('codex-gpt-6-astra-medium')).toBe(2.5);
    expect(codexFastTierCredits('codex-gpt-6-sol-medium')).toBe(2.5);
    expect(codexFastTierCredits('codex-gpt-6-luna-high')).toBe(2.5);
    expect(codexFastTierCredits('codex-gpt-5.6-sol-medium')).toBe(2.5);
    expect(codexFastTierCredits('codex-gpt-5.6-terra-low')).toBe(2.5);
    expect(codexFastTierCredits('codex-gpt-5.6-luna-high')).toBe(2.5);
    expect(codexFastTierCredits('codex-gpt-5.5-medium')).toBe(2.5);
    expect(codexFastTierCredits('codex-gpt-5.4-medium')).toBe(2);
  });

  it('returns null for models without the tier, and for non-codex / unknown / missing ids', () => {
    for (const m of CODEX_CLI_MODELS.filter((x) => x.cliValue === 'gpt-5.4-mini')) {
      expect(codexFastTierCredits(m.id), m.id).toBeNull();
    }
    expect(codexFastTierCredits('opus-4.8')).toBeNull();
    expect(codexFastTierCredits('not-a-codex-5.3-high')).toBeNull();
    expect(codexFastTierCredits('totally-unknown-model')).toBeNull();
    expect(codexFastTierCredits(undefined)).toBeNull();
    expect(codexFastTierCredits('')).toBeNull();
  });

  it('offers Fast on exactly the advertised slugs (fails closed for a newly added model)', () => {
    // Pins both directions: a typo'd map key silently disabling Fast, and a new slug silently
    // gaining it. A model added to CODEX_MODEL_SLUGS gets no tier until it is added deliberately.
    const withFast = CODEX_MODEL_SLUGS.map((s) => s.slug).filter((slug) =>
      CODEX_CLI_MODELS.some((m) => m.cliValue === slug && codexFastTierCredits(m.id) !== null),
    );
    expect(withFast).toEqual([
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });
});
