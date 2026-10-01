import { describe, expect, it } from 'vitest';
import { LAUNCH_FLAGS } from '../launch-flags';
import { CODEX_CLI_MODELS, CODEX_DEFAULT_MODEL_ID } from './codex-cli-models';
import {
  CLAUDE_CODE_MODELS,
  CLAUDE_CODE_MODELS_CATALOG,
  CLAUDE_MODEL_FAMILIES,
  CLAUDE_MODEL_ID_MAP,
  CLAUDE_MODEL_IDS,
  CODEX_MODEL_FAMILIES,
  CODEX_MODEL_ID_MAP,
  CODEX_MODELS,
  claudeModelRequires1M,
  claudeModelToPickerItem,
  claudeModelUsesAdaptiveThinking,
  codexModelToPickerItem,
  getClaudeCliModel,
  getClaudeSdkEffort,
  getClaudeThinkingBudget,
  isClaudeModelVisible,
  isClaudeUltraModel,
  isCodexModelVisible,
  normalizeModelIdForExecutionAccount,
  splitNewestFamilies,
  supportsNativeAutoReview,
} from './models';

describe('supportsNativeAutoReview', () => {
  it.each([
    'sonnet',
    'opus-4.7',
    'opus-4.8',
    'opus-5',
    'opus-5.5',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',
    'sonnet-5.5',
    'claude-sonnet-5-5',
  ])('supports current Claude model %s', (model) => {
    expect(supportsNativeAutoReview('claude-code', model)).toBe(true);
  });

  it.each(['haiku', 'claude-3-haiku', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-3-7'])(
    'rejects unsupported Claude model %s',
    (model) => {
      expect(supportsNativeAutoReview('claude-code', model)).toBe(false);
    },
  );

  it('supports Codex and rejects providers without a native reviewer', () => {
    expect(supportsNativeAutoReview('codex', undefined)).toBe(true);
    expect(supportsNativeAutoReview('github', 'sonnet')).toBe(false);
  });

  it('fails closed for a missing Claude picker model unless the SDK default is explicit', () => {
    expect(supportsNativeAutoReview('claude-code', undefined)).toBe(false);
    expect(
      supportsNativeAutoReview('claude-code', undefined, { allowClaudeSdkDefault: true }),
    ).toBe(true);
  });
});

describe('normalizeModelIdForExecutionAccount', () => {
  it('maps an id from a retired provider to sonnet', () => {
    expect(normalizeModelIdForExecutionAccount(false, 'cursor-auto')).toBe('sonnet');
  });

  it('preserves valid Claude id', () => {
    const id = CLAUDE_MODEL_IDS[0];
    expect(normalizeModelIdForExecutionAccount(false, id)).toBe(id);
  });

  it('preserves Fable 5.1 picker ids for Claude Code account', () => {
    expect(normalizeModelIdForExecutionAccount(false, 'fable-5.1')).toBe('fable-5.1');
    expect(normalizeModelIdForExecutionAccount(false, 'fable-5.1-max')).toBe('fable-5.1-max');
  });

  it('preserves Fable 5 picker ids for Claude Code account (or falls back when gated)', () => {
    expect(normalizeModelIdForExecutionAccount(false, 'fable-5')).toBe(
      LAUNCH_FLAGS.fable5 ? 'fable-5' : 'sonnet',
    );
    expect(normalizeModelIdForExecutionAccount(false, 'fable-5-1m-max')).toBe(
      LAUNCH_FLAGS.fable5 ? 'fable-5-1m-max' : 'sonnet',
    );
  });

  it('snaps a non-Codex id to the Codex default when a Codex account is active', () => {
    expect(normalizeModelIdForExecutionAccount(true, 'sonnet')).toBe(CODEX_DEFAULT_MODEL_ID);
  });

  it('preserves a valid Codex id for a Codex account', () => {
    const id = CODEX_MODELS[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) expect.fail('CODEX_MODELS[0].id must exist');
    expect(normalizeModelIdForExecutionAccount(true, id)).toBe(id);
  });

  it('snaps a codex-looking id that is not in the catalog to the codex default', () => {
    // Guards a future .startsWith('codex') slip: only catalog membership may preserve an id.
    expect(normalizeModelIdForExecutionAccount(true, 'codex-not-a-real-model')).toBe(
      CODEX_DEFAULT_MODEL_ID,
    );
  });
});

describe('codex model id namespace', () => {
  it('codex ids are disjoint from the claude id namespace (the router depends on it)', () => {
    for (const id of CODEX_MODELS.map((m) => m.id)) {
      expect(CLAUDE_MODEL_IDS.includes(id), `${id} collides with a claude id`).toBe(false);
    }
  });
});

// The renderer (settings ModelsSection, flow picker) consumes the codex catalog through
// these `models.ts` re-exports/helpers, NOT the deep `codex-cli-models` module.
describe('CODEX re-exports + UI helpers', () => {
  it('re-exports the same catalog object as codex-cli-models (no diverging copy)', () => {
    expect(CODEX_MODELS).toBe(CODEX_CLI_MODELS);
    expect(CODEX_MODELS.length).toBeGreaterThan(0);
  });

  it('has no duplicate model ids', () => {
    const ids = CODEX_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a non-empty cliValue for every model', () => {
    for (const m of CODEX_MODELS) expect(m.cliValue, `${m.id} has empty cliValue`).toBeTruthy();
  });

  it('CODEX_MODEL_ID_MAP maps every catalog id to its slug', () => {
    for (const m of CODEX_MODELS) {
      expect(CODEX_MODEL_ID_MAP).toHaveProperty(m.id);
      expect(CODEX_MODEL_ID_MAP[m.id]).toBe(m.cliValue);
    }
  });

  it('CODEX_MODEL_FAMILIES is deduped to one entry per family (settings toggles a whole family)', () => {
    const ids = CODEX_MODEL_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    // One family per distinct slug — the effort tiers collapse into a single visibility row.
    expect(ids.length).toBe(new Set(CODEX_MODELS.map((m) => m.familyId)).size);
  });

  it('codexModelToPickerItem maps shape for the UI (effort tier → detail)', () => {
    const first = CODEX_MODELS[0];
    const item = codexModelToPickerItem(first);
    expect(item.id).toBe(first.id);
    expect(item.name).toBe(first.familyName);
    expect(item.detail).toBe(first.variantLabel);
    expect(item.contextLabel).toBe(first.contextWindow);
    expect(item.familyId).toBe(first.familyId);
  });

  it('codexModelToPickerItem drops an empty variantLabel to undefined (no blank detail row)', () => {
    const blank = { ...CODEX_MODELS[0], variantLabel: '' };
    expect(codexModelToPickerItem(blank).detail).toBeUndefined();
  });

  it('isCodexModelVisible hides a model only when its OWN family id is hidden', () => {
    const model = CODEX_MODELS[0];
    expect(isCodexModelVisible(model, [])).toBe(true);
    expect(isCodexModelVisible(model, [model.familyId])).toBe(false);
    // A different family being hidden never hides this one.
    expect(isCodexModelVisible(model, ['some-other-family'])).toBe(true);
  });
});

describe('CLAUDE_CODE_MODELS data integrity', () => {
  it('has no duplicate model ids', () => {
    const ids = CLAUDE_CODE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a valid cliValue for every model (short alias or claude-*-N-N id)', () => {
    const shortAliases = ['opus', 'sonnet', 'haiku'];
    for (const m of CLAUDE_CODE_MODELS) {
      expect(m.cliValue, `${m.id} has empty cliValue`).toBeTruthy();
      const isShort = shortAliases.includes(m.cliValue);
      const isFullId = /^claude-(opus|sonnet|haiku|fable)-/.test(m.cliValue);
      expect(isShort || isFullId, `${m.id} cliValue ${m.cliValue} is not recognized`).toBe(true);
    }
  });

  it('every model has a non-empty contextWindow label', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      expect(m.contextWindow.trim(), `${m.id} missing contextWindow`).toBeTruthy();
    }
  });

  it('CLAUDE_MODEL_ID_MAP contains every model id', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      expect(CLAUDE_MODEL_ID_MAP).toHaveProperty(m.id);
      expect(CLAUDE_MODEL_ID_MAP[m.id]).toBe(m.cliValue);
    }
  });

  it('claudeModelToPickerItem maps shape for the UI', () => {
    const first = CLAUDE_CODE_MODELS[0];
    const item = claudeModelToPickerItem(first);
    expect(item.id).toBe(first.id);
    expect(item.name).toBe(first.familyName);
    expect(item.contextLabel).toBe(first.contextWindow);
    expect(item.familyId).toBe(first.familyId);
  });

  it('claudeModelToPickerItem yields id, name, and version for every model', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      const p = claudeModelToPickerItem(m);
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.version).toBeTruthy();
    }
  });

  it('claudeModelToPickerItem version matches family', () => {
    for (const [id, expectedVersion] of [
      // Opus 5.5 / Opus 5 — versioned ids
      ['opus-5.5', '5.5'],
      ['opus-5.5-max', '5.5'],
      ['opus-5', '5'],
      ['opus-5-max', '5'],
      // Opus 4.7 — versioned ids
      ['opus-4.7', '4.7'],
      ['opus-4.7-1m', '4.7'],
      ['opus-4.7-xhigh', '4.7'],
      ['opus-4.7-max', '4.7'],
      ['opus-4.7-1m-max', '4.7'],
      // Opus 4.6 — legacy unversioned ids (preserved for backward compat)
      ['opus', '4.6'],
      ['opus-1m', '4.6'],
      ['sonnet', '4.6'],
      ['sonnet-1m', '4.6'],
      ['haiku', '4.5'],
    ] as const) {
      const m = CLAUDE_CODE_MODELS.find((x) => x.id === id);
      expect(m, id).toBeDefined();
      if (m) expect(claudeModelToPickerItem(m).version).toBe(expectedVersion);
    }
  });

  it('no model has enableThinking — thinking is controlled by the global toggle', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      expect((m as Record<string, unknown>).enableThinking, m.id).toBeUndefined();
    }
  });
});

// Edge Case Tests - Critical & High Priority

describe('Edge Case: Model ID Mapping Gaps (High)', () => {
  it('getClaudeCliModel returns default "sonnet" for unknown model ID', () => {
    expect(getClaudeCliModel('unknown-model-id')).toBe('sonnet');
    expect(getClaudeCliModel('old-deprecated-model')).toBe('sonnet');
    expect(getClaudeCliModel('')).toBe('sonnet');
  });

  it('getClaudeCliModel maps Opus variants to version-pinned Anthropic IDs', () => {
    // Opus 4.6 (legacy unversioned ids → claude-opus-4-6)
    expect(getClaudeCliModel('opus')).toBe('claude-opus-4-6');
    expect(getClaudeCliModel('opus-low')).toBe('claude-opus-4-6');
    expect(getClaudeCliModel('opus-high')).toBe('claude-opus-4-6');
    expect(getClaudeCliModel('opus-1m')).toBe('claude-opus-4-6');
    expect(getClaudeCliModel('opus-1m-low')).toBe('claude-opus-4-6');
    expect(getClaudeCliModel('opus-1m-high')).toBe('claude-opus-4-6');
    // Opus 4.7 (versioned ids → claude-opus-4-7, includes max)
    expect(getClaudeCliModel('opus-4.7')).toBe('claude-opus-4-7');
    expect(getClaudeCliModel('opus-4.7-low')).toBe('claude-opus-4-7');
    expect(getClaudeCliModel('opus-4.7-high')).toBe('claude-opus-4-7');
    expect(getClaudeCliModel('opus-4.7-xhigh')).toBe('claude-opus-4-7');
    expect(getClaudeCliModel('opus-4.7-max')).toBe('claude-opus-4-7');
    expect(getClaudeCliModel('opus-4.7-1m')).toBe('claude-opus-4-7');
    expect(getClaudeCliModel('opus-4.7-1m-max')).toBe('claude-opus-4-7');
    // Sonnet / Haiku keep short aliases (single-version families)
    expect(getClaudeCliModel('sonnet')).toBe('sonnet');
    expect(getClaudeCliModel('sonnet-1m-high')).toBe('sonnet');
    expect(getClaudeCliModel('haiku')).toBe('haiku');
  });

  it('CLAUDE_MODEL_ID_MAP pins Opus ids to version-specific Anthropic model IDs', () => {
    for (const ctx of ['', '-1m']) {
      for (const effort of ['', '-low', '-high']) {
        const id = `opus${ctx}${effort}`;
        expect(CLAUDE_MODEL_ID_MAP[id], id).toBe('claude-opus-4-6');
      }
    }
    for (const ctx of ['', '-1m']) {
      for (const effort of ['', '-low', '-high', '-xhigh', '-max']) {
        const id = `opus-4.7${ctx}${effort}`;
        expect(CLAUDE_MODEL_ID_MAP[id], id).toBe('claude-opus-4-7');
      }
    }
    for (const ctx of ['', '-1m']) {
      for (const effort of ['', '-low', '-high']) {
        const id = `sonnet${ctx}${effort}`;
        expect(CLAUDE_MODEL_ID_MAP[id], id).toBe('sonnet');
      }
    }
  });

  it('CLAUDE_MODEL_ID_MAP has entries for all context tier variants', () => {
    expect(CLAUDE_MODEL_ID_MAP['opus-1m']).toBe('claude-opus-4-6');
    expect(CLAUDE_MODEL_ID_MAP['opus-4.7-1m']).toBe('claude-opus-4-7');
    expect(CLAUDE_MODEL_ID_MAP['sonnet-1m']).toBe('sonnet');
  });

  it('CLAUDE_MODEL_ID_MAP has entries for all base variants', () => {
    expect(CLAUDE_MODEL_ID_MAP.opus).toBe('claude-opus-4-6');
    expect(CLAUDE_MODEL_ID_MAP['opus-4.7']).toBe('claude-opus-4-7');
    expect(CLAUDE_MODEL_ID_MAP.sonnet).toBe('sonnet');
    expect(CLAUDE_MODEL_ID_MAP.haiku).toBe('haiku');
  });
});

describe('getClaudeSdkEffort', () => {
  it('maps picker suffixes to SDK effort levels', () => {
    expect(getClaudeSdkEffort('opus-4.7-max')).toBe('max');
    expect(getClaudeSdkEffort('opus-4.7-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('opus-4.7-low')).toBe('low');
    expect(getClaudeSdkEffort('opus-4.7-high')).toBe('high');
    expect(getClaudeSdkEffort('opus-4.7')).toBe('medium');
    expect(getClaudeSdkEffort('sonnet')).toBe('medium');
    expect(getClaudeSdkEffort('sonnet-high')).toBe('high');
  });

  // `-xhigh` must not collide with the `-high` branch (different suffix; checked first).
  it('resolves -xhigh to xhigh for every supporting family', () => {
    expect(getClaudeSdkEffort('opus-5-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('opus-4.8-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('opus-4.7-1m-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('fable-5-xhigh')).toBe('xhigh');
  });

  it('defaults Opus 4.8 bare id to high effort, with explicit lower tiers + xhigh + max', () => {
    expect(getClaudeSdkEffort('opus-4.8')).toBe('high');
    expect(getClaudeSdkEffort('opus-4.8-low')).toBe('low');
    expect(getClaudeSdkEffort('opus-4.8-medium')).toBe('medium');
    expect(getClaudeSdkEffort('opus-4.8-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('opus-4.8-max')).toBe('max');
  });

  // The bundled CLI (≥ 2.1.173) accepts `low|medium|high|xhigh|max`; the SDK silently downgrades
  // an unsupported level per model. Earlier CLIs rejected `--effort xhigh` and crashed the executor —
  // this guard now confirms every resolved effort is in the *current* accepted set (xhigh included).
  it('only ever returns CLI-valid effort levels (low|medium|high|xhigh|max)', () => {
    const CLI_VALID = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const m of CLAUDE_CODE_MODELS) {
      const effort = getClaudeSdkEffort(m.id);
      if (effort !== undefined) {
        expect(CLI_VALID.has(effort), `${m.id} → "${effort}" is not a valid --effort value`).toBe(
          true,
        );
      }
    }
  });
});

describe('Ultra', () => {
  it('twins every tier, exactly on the ladders that offer xhigh', () => {
    const byFamily = (tier: string) =>
      new Set(CLAUDE_CODE_MODELS.filter((m) => m.id.endsWith(tier)).map((m) => m.familyId));
    expect(byFamily('-ultra')).toEqual(byFamily('-xhigh'));
    expect(byFamily('-ultra').size).toBeGreaterThan(0);
    for (const twin of CLAUDE_CODE_MODELS.filter((m) => m.ultra)) {
      const base = CLAUDE_CODE_MODELS.find((m) => `${m.id}-ultra` === twin.id);
      expect(base?.effort, twin.id).toBe(twin.effort);
      expect(twin.variantLabel).toBe(`${base?.variantLabel} · Ultra`);
    }
  });

  it("runs at its own tier's effort", () => {
    expect(getClaudeSdkEffort('opus-5.5-ultra')).toBe('medium');
    expect(getClaudeSdkEffort('opus-4.7-1m-low-ultra')).toBe('low');
    expect(getClaudeSdkEffort('fable-5.1-max-ultra')).toBe('max');
    expect(isClaudeUltraModel('fable-5.1-low-ultra')).toBe(true);
    expect(isClaudeUltraModel('fable-5.1-max')).toBe(false);
  });

  it('keeps an Ultra picker id through account normalization (a real catalog member)', () => {
    expect(normalizeModelIdForExecutionAccount(false, 'opus-5.5-ultra')).toBe('opus-5.5-ultra');
  });
});

describe('Opus 4.8 catalog (1M-native, High default)', () => {
  it('pins every 4.8 variant cliValue to claude-opus-4-8', () => {
    for (const effort of ['', '-low', '-medium', '-xhigh', '-max']) {
      const id = `opus-4.8${effort}`;
      expect(CLAUDE_MODEL_ID_MAP[id], id).toBe('claude-opus-4-8');
    }
  });

  it('exposes a single 1M context row per effort (no 200k, no -1m duplicate)', () => {
    const ids = CLAUDE_CODE_MODELS.filter((m) => m.familyId === 'opus-4.8' && !m.ultra).map(
      (m) => m.id,
    );
    expect(ids).toEqual([
      'opus-4.8',
      'opus-4.8-low',
      'opus-4.8-medium',
      'opus-4.8-xhigh',
      'opus-4.8-max',
    ]);
    for (const m of CLAUDE_CODE_MODELS.filter((x) => x.familyId === 'opus-4.8')) {
      expect(m.contextWindow).toBe('1M context');
    }
  });

  it('labels the bare row High (its default effort), not Medium', () => {
    const bare = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus-4.8');
    expect(bare).toBeDefined();
    if (!bare) return;
    expect(bare.variantLabel).toBe('High');
    expect(claudeModelToPickerItem(bare).detail).toBe('High');
  });

  it('sits directly below Opus 5 in the picker', () => {
    const families = CLAUDE_CODE_MODELS.map((m) => m.familyId);
    expect(families.indexOf('opus-5')).toBeLessThan(families.indexOf('opus-4.8'));
    expect(families.indexOf('opus-4.8')).toBeLessThan(families.indexOf('opus-4.7'));
  });

  // 1M is the default window for Opus 4.8 (no `context-1m-2025-08-07` beta header — the API
  // serves 1M by default and the migration guide says to remove the header). A stray `-1m`
  // variant would wrongly flip claudeModelRequires1M → attach the redundant beta.
  it('is 1M-native: no -1m variant, never requests the 1M context beta', () => {
    for (const m of CLAUDE_CODE_MODELS.filter((x) => x.familyId === 'opus-4.8')) {
      expect(m.id, `${m.id} must not carry a -1m suffix`).not.toContain('-1m');
      expect(claudeModelRequires1M(m.id), `${m.id} must not request the 1M beta`).toBe(false);
    }
  });
});

describe('Opus 5.5 catalog (1M-native, Medium default, full effort ladder)', () => {
  const opus55 = () => CLAUDE_CODE_MODELS.filter((m) => m.familyId === 'opus-5.5' && !m.ultra);

  it('exposes one 1M row per effort: Medium default + low/high/xhigh/max (no 200k, no -1m)', () => {
    expect(opus55().map((m) => m.id)).toEqual([
      'opus-5.5',
      'opus-5.5-low',
      'opus-5.5-high',
      'opus-5.5-xhigh',
      'opus-5.5-max',
    ]);
    for (const m of opus55()) {
      expect(m.contextWindow).toBe('1M context');
      expect(claudeModelRequires1M(m.id), m.id).toBe(false);
    }
  });

  it('labels the bare row Medium (the API default for Opus 5.5)', () => {
    expect(CLAUDE_CODE_MODELS.find((m) => m.id === 'opus-5.5')?.variantLabel).toBe('Medium');
  });

  it('pins every variant cliValue to claude-opus-5-5', () => {
    for (const m of opus55()) expect(CLAUDE_MODEL_ID_MAP[m.id], m.id).toBe('claude-opus-5-5');
  });

  // `opus-5.5` also starts with `opus-5`, whose bare id resolves to high.
  it('resolves effort: bare → medium, not the Opus 5 high default', () => {
    expect(getClaudeSdkEffort('opus-5.5')).toBe('medium');
    expect(getClaudeSdkEffort('opus-5.5-low')).toBe('low');
    expect(getClaudeSdkEffort('opus-5.5-high')).toBe('high');
    expect(getClaudeSdkEffort('opus-5.5-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('opus-5.5-max')).toBe('max');
  });

  it('sits directly above Opus 5 in the picker', () => {
    const families = CLAUDE_MODEL_FAMILIES.map((f) => f.id);
    expect(families.indexOf('opus-5.5')).toBe(families.indexOf('opus-5') - 1);
  });
});

describe('Opus 5 catalog (1M-native, High default, full effort ladder)', () => {
  const opus5 = () => CLAUDE_CODE_MODELS.filter((m) => m.familyId === 'opus-5' && !m.ultra);

  it('exposes one 1M row per effort: High default + low/medium/xhigh/max (no 200k, no -1m)', () => {
    expect(opus5().map((m) => m.id)).toEqual([
      'opus-5',
      'opus-5-low',
      'opus-5-medium',
      'opus-5-xhigh',
      'opus-5-max',
    ]);
    for (const m of opus5()) expect(m.contextWindow).toBe('1M context');
  });

  it('labels the bare row High (its default effort), not Medium', () => {
    const bare = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus-5');
    expect(bare?.variantLabel).toBe('High');
  });

  it('pins every variant cliValue to claude-opus-5', () => {
    for (const m of opus5()) expect(CLAUDE_MODEL_ID_MAP[m.id], m.id).toBe('claude-opus-5');
  });

  // The bare id must not fall through to the generic `opus-` branch, which resolves to medium.
  it('resolves effort: bare → high, low/medium/xhigh/max per suffix', () => {
    expect(getClaudeSdkEffort('opus-5')).toBe('high');
    expect(getClaudeSdkEffort('opus-5-low')).toBe('low');
    expect(getClaudeSdkEffort('opus-5-medium')).toBe('medium');
    expect(getClaudeSdkEffort('opus-5-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('opus-5-max')).toBe('max');
  });

  // 1M is the default window (no `context-1m-2025-08-07` beta header — like Opus 4.8). A stray
  // -1m variant would wrongly flip claudeModelRequires1M → attach the redundant beta.
  it('is 1M-native: no -1m variant, never requests the 1M context beta', () => {
    for (const m of opus5()) {
      expect(m.id, `${m.id} must not carry a -1m suffix`).not.toContain('-1m');
      expect(claudeModelRequires1M(m.id), `${m.id} must not request the 1M beta`).toBe(false);
    }
  });

  // Opus 4.6 keeps the legacy unversioned `opus*` id scheme; a collision would make a saved
  // selection resolve to the wrong family.
  it('does not collide with the legacy Opus 4.6 id namespace', () => {
    const legacy = CLAUDE_CODE_MODELS.filter((m) => m.familyId === 'opus-4.6').map((m) => m.id);
    for (const id of opus5().map((m) => m.id)) expect(legacy, id).not.toContain(id);
  });
});

describe.each([
  { family: 'sonnet-5', cli: 'claude-sonnet-5' },
  { family: 'sonnet-5.5', cli: 'claude-sonnet-5-5' },
])('$family catalog (1M-native, High default, full effort ladder)', ({ family, cli }) => {
  const rows = () => CLAUDE_CODE_MODELS.filter((m) => m.familyId === family && !m.ultra);

  // Sonnet 5+ supports the same effort ladder as Opus 4.8 (High default + Low/Medium/Xhigh/Max) per
  // the effort docs — NOT the Sonnet 4.6 Low/Medium/High set.
  it('exposes one 1M row per effort: High default + low/medium/xhigh/max (no 200k, no -1m)', () => {
    expect(rows().map((m) => m.id)).toEqual(
      ['', '-low', '-medium', '-xhigh', '-max'].map((s) => `${family}${s}`),
    );
    for (const m of rows()) expect(m.contextWindow).toBe('1M context');
  });

  it('labels the bare row High (its default effort), not Medium', () => {
    expect(CLAUDE_CODE_MODELS.find((m) => m.id === family)?.variantLabel).toBe('High');
  });

  it('pins every variant cliValue to the versioned model id', () => {
    for (const m of rows()) expect(CLAUDE_MODEL_ID_MAP[m.id], m.id).toBe(cli);
  });

  it('resolves effort: bare → high, low/medium/xhigh/max per suffix', () => {
    expect(getClaudeSdkEffort(family)).toBe('high');
    for (const e of ['low', 'medium', 'xhigh', 'max'] as const) {
      expect(getClaudeSdkEffort(`${family}-${e}`)).toBe(e);
    }
  });

  // 1M is the default window (no `context-1m-2025-08-07` beta header — like Opus 4.8). A stray
  // -1m variant would wrongly flip claudeModelRequires1M → attach the redundant beta.
  it('is 1M-native: no -1m variant, never requests the 1M context beta', () => {
    for (const m of rows()) {
      expect(m.id, `${m.id} must not carry a -1m suffix`).not.toContain('-1m');
      expect(claudeModelRequires1M(m.id), `${m.id} must not request the 1M beta`).toBe(false);
    }
  });

  it('surfaces before Sonnet 4.6 (separate family, distinct from the sonnet alias)', () => {
    const ids = CLAUDE_CODE_MODELS.map((m) => m.familyId);
    expect(ids.indexOf(family)).toBeLessThan(ids.indexOf('sonnet'));
  });
});

describe('claudeModelUsesAdaptiveThinking', () => {
  it('is true for adaptive-thinking families (manual budget_tokens would 400)', () => {
    for (const cli of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
    ]) {
      expect(claudeModelUsesAdaptiveThinking(cli), cli).toBe(true);
    }
  });

  it('is false for manual-thinking families and unknown/cross-provider values', () => {
    for (const cli of ['sonnet', 'claude-opus-4-6', 'haiku', 'gpt-5.3', '']) {
      expect(claudeModelUsesAdaptiveThinking(cli), cli).toBe(false);
    }
  });

  // Ties the helper to the catalog `adaptiveThinking` flag — the single source of truth the SDK
  // thinking path reads. Guards against a family declaring adaptive but the helper missing it.
  it('maps every adaptiveThinking catalog family cliValue to true', () => {
    for (const m of CLAUDE_CODE_MODELS_CATALOG.filter((x) => x.adaptiveThinking)) {
      expect(claudeModelUsesAdaptiveThinking(m.cliValue), m.id).toBe(true);
    }
  });
});

describe('Edge Case: Effort Tier Budgets (Critical)', () => {
  it('effort tiers produce distinct budgets (low < medium < high)', () => {
    for (const base of ['opus', 'sonnet']) {
      const low = getClaudeThinkingBudget(`${base}-low`);
      const medium = getClaudeThinkingBudget(base);
      const high = getClaudeThinkingBudget(`${base}-high`);
      expect(low).toBeDefined();
      expect(medium).toBeDefined();
      expect(high).toBeDefined();
      expect(low).toBeLessThan(medium as number);
      expect(medium).toBeLessThan(high as number);
    }
  });

  it('Opus 4.7 Max budget is above High and under the 64k max_tokens cap', () => {
    const high = getClaudeThinkingBudget('opus-4.7-high');
    const maxTier = getClaudeThinkingBudget('opus-4.7-max');
    expect(high).toBeDefined();
    expect(maxTier).toBeDefined();
    expect(maxTier).toBeGreaterThan(high as number);
    expect(maxTier as number).toBeLessThan(64_000);
  });

  it('1M variants have the same budgets as 200k counterparts', () => {
    const tiers = [
      { prefix: 'opus', efforts: ['', '-low', '-high'] },
      { prefix: 'opus-4.7', efforts: ['', '-low', '-high', '-xhigh', '-max'] },
      { prefix: 'sonnet', efforts: ['', '-low', '-high'] },
    ];
    for (const { prefix, efforts } of tiers) {
      for (const effort of efforts) {
        const std = getClaudeThinkingBudget(`${prefix}${effort}`);
        const oneM = getClaudeThinkingBudget(`${prefix}-1m${effort}`);
        expect(oneM, `${prefix}-1m${effort}`).toBe(std);
      }
    }
  });

  it('high budget stays under 64k to avoid max_tokens API errors', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      if (m.maxThinkingTokens) {
        expect(m.maxThinkingTokens, `${m.id} budget too high`).toBeLessThan(64_000);
      }
    }
  });

  it('effort variants share familyId with base variants', () => {
    const opus = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus');
    const opusHigh = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus-high');
    expect(opus?.familyId).toBe(opusHigh?.familyId);
    expect(opus?.familyId).toBe('opus-4.6');
  });
});

describe('Edge Case: Hidden Model Family with Active Selection (High)', () => {
  it('isClaudeModelVisible hides all variants when familyId is hidden', () => {
    const opus = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus');
    const opusHigh = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus-high');
    expect(opus).toBeDefined();
    expect(opusHigh).toBeDefined();
    if (!opus || !opusHigh) return;

    const hiddenFamilies = ['opus-4.6'];
    expect(isClaudeModelVisible(opus, hiddenFamilies)).toBe(false);
    expect(isClaudeModelVisible(opusHigh, hiddenFamilies)).toBe(false);
  });

  it('hiding Opus 4.6 leaves Opus 4.7 visible (separate families)', () => {
    const opus46 = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus');
    const opus47 = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus-4.7');
    expect(opus46).toBeDefined();
    expect(opus47).toBeDefined();
    if (!opus46 || !opus47) return;
    const hidden = ['opus-4.6'];
    expect(isClaudeModelVisible(opus46, hidden)).toBe(false);
    expect(isClaudeModelVisible(opus47, hidden)).toBe(true);
  });

  it('isClaudeModelVisible shows variants when familyId is not hidden', () => {
    const sonnet = CLAUDE_CODE_MODELS.find((m) => m.id === 'sonnet');
    const sonnetHigh = CLAUDE_CODE_MODELS.find((m) => m.id === 'sonnet-high');
    expect(sonnet).toBeDefined();
    expect(sonnetHigh).toBeDefined();
    if (!sonnet || !sonnetHigh) return;

    const hiddenFamilies = ['opus-4.6'];
    expect(isClaudeModelVisible(sonnet, hiddenFamilies)).toBe(true);
    expect(isClaudeModelVisible(sonnetHigh, hiddenFamilies)).toBe(true);
  });

  it('hiding a family hides all effort and context variants', () => {
    const hidden = ['sonnet'];
    for (const model of CLAUDE_CODE_MODELS) {
      if (model.familyId === 'sonnet') {
        expect(isClaudeModelVisible(model, hidden)).toBe(false);
      } else {
        expect(isClaudeModelVisible(model, hidden)).toBe(true);
      }
    }
  });
});

describe('Edge Case: Model Family Structure (Medium)', () => {
  it('CLAUDE_MODEL_FAMILIES has unique family IDs', () => {
    const familyIds = CLAUDE_MODEL_FAMILIES.map((f) => f.id);
    expect(new Set(familyIds).size).toBe(familyIds.length);
  });

  it('CLAUDE_MODEL_FAMILIES contains all families from CLAUDE_CODE_MODELS', () => {
    const modelFamilyIds = new Set(CLAUDE_CODE_MODELS.map((m) => m.familyId));
    const declaredFamilyIds = new Set(CLAUDE_MODEL_FAMILIES.map((f) => f.id));
    expect(declaredFamilyIds).toEqual(modelFamilyIds);
  });

  it('each family in CLAUDE_MODEL_FAMILIES has at least one model', () => {
    for (const family of CLAUDE_MODEL_FAMILIES) {
      const modelsInFamily = CLAUDE_CODE_MODELS.filter((m) => m.familyId === family.id);
      expect(modelsInFamily.length, `Family ${family.id} has no models`).toBeGreaterThan(0);
    }
  });

  it('CLAUDE_MODEL_FAMILIES splits Opus 4.6 and 4.7 into separate rows with versioned names', () => {
    const ids = CLAUDE_MODEL_FAMILIES.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['opus-4.7', 'opus-4.6', 'sonnet', 'haiku']));
    const opus47 = CLAUDE_MODEL_FAMILIES.find((f) => f.id === 'opus-4.7');
    const opus46 = CLAUDE_MODEL_FAMILIES.find((f) => f.id === 'opus-4.6');
    expect(opus47?.name).toBe('Opus 4.7');
    expect(opus46?.name).toBe('Opus 4.6');
  });
});

describe('Edge Case: Context Window Labels (Medium)', () => {
  it('no model has "extended thinking" in context label (thinking is toggle-controlled)', () => {
    for (const model of CLAUDE_CODE_MODELS) {
      expect(model.contextWindow).not.toContain('extended thinking');
    }
  });

  it('all models show context window size', () => {
    for (const model of CLAUDE_CODE_MODELS) {
      expect(model.contextWindow).toMatch(/\d+[kM]/i);
    }
  });
});

describe('Edge Case: Claude CLI value shape (Medium)', () => {
  it('getClaudeCliModel returns only short aliases or Anthropic model ids', () => {
    for (const model of CLAUDE_CODE_MODELS) {
      const cliValue = getClaudeCliModel(model.id);
      const isShort = ['opus', 'sonnet', 'haiku'].includes(cliValue);
      const isAnthropicId = /^claude-(opus|sonnet|haiku|fable)-/.test(cliValue);
      expect(isShort || isAnthropicId, `${model.id} → ${cliValue}`).toBe(true);
    }
  });
});

describe('Edge Case: buildFamily Variant Structure (High)', () => {
  it('each family has exactly one Medium variant per context tier', () => {
    const families = ['opus-4.7', 'opus-4.6', 'sonnet'];
    for (const familyId of families) {
      const familyModels = CLAUDE_CODE_MODELS.filter((m) => m.familyId === familyId);
      const mediumModels = familyModels.filter((m) => m.variantLabel === 'Medium');
      const med200k = mediumModels.filter((m) => !m.id.includes('-1m'));
      expect(med200k.length, `${familyId} should have 1 medium 200k`).toBe(1);
    }
  });

  it('every model has a maxThinkingTokens budget', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      if (m.familyId === 'haiku') continue;
      expect(m.maxThinkingTokens, `${m.id} missing maxThinkingTokens`).toBeGreaterThan(0);
    }
  });

  it('every variant has a non-empty variantLabel (no "Default" fallback needed)', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      if (m.familyId === 'haiku') continue; // Haiku is a single-variant family
      expect(m.variantLabel, `${m.id} has empty variantLabel`).toBeTruthy();
    }
  });
});

describe('Edge Case: Picker Item Shape for Unified Trigger (High)', () => {
  it('Claude picker items include version so trigger can build "Name Version" label', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      const p = claudeModelToPickerItem(m);
      expect(p.version, `${m.id} picker item missing version`).toBeTruthy();
    }
  });

  it('Medium variants produce detail "Medium" so trigger hides it', () => {
    const opus = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus');
    expect(opus).toBeDefined();
    if (!opus) return;
    const p = claudeModelToPickerItem(opus);
    expect(p.detail).toBe('Medium');
  });

  it('non-Medium variants produce a detail that appears in trigger', () => {
    const opusHigh = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus-high');
    expect(opusHigh).toBeDefined();
    if (!opusHigh) return;
    const p = claudeModelToPickerItem(opusHigh);
    expect(p.detail).toBeTruthy();
    expect(p.detail).not.toBe('Medium');
  });

  it('Opus 4.6 and 4.7 are separate families with distinct familyIds and cliValues', () => {
    const opus46 = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus');
    const opus47 = CLAUDE_CODE_MODELS.find((m) => m.id === 'opus-4.7');
    expect(opus46?.pickerVersion).toBe('4.6');
    expect(opus47?.pickerVersion).toBe('4.7');
    expect(opus46?.familyId).toBe('opus-4.6');
    expect(opus47?.familyId).toBe('opus-4.7');
    expect(opus46?.cliValue).toBe('claude-opus-4-6');
    expect(opus47?.cliValue).toBe('claude-opus-4-7');
    expect(opus46?.familyName).toBe('Opus 4.6');
    expect(opus47?.familyName).toBe('Opus 4.7');
  });
});

describe('Fable 5.1 catalog (1M-native, High default)', () => {
  const FABLE_5_1_VARIANTS = [
    'fable-5.1',
    'fable-5.1-low',
    'fable-5.1-medium',
    'fable-5.1-xhigh',
    'fable-5.1-max',
  ];

  it('has exactly 5 variants plus Ultra twins: single 1M row × full effort ladder', () => {
    const ids = CLAUDE_CODE_MODELS.filter((m) => m.familyId === 'fable-5.1' && !m.ultra).map(
      (m) => m.id,
    );
    expect(ids).toEqual(FABLE_5_1_VARIANTS);
  });

  it('pins every variant cliValue to claude-fable-5-1 with a 1M context label', () => {
    for (const id of FABLE_5_1_VARIANTS) {
      const model = CLAUDE_CODE_MODELS.find((m) => m.id === id);
      expect(model?.cliValue, id).toBe('claude-fable-5-1');
      expect(model?.contextWindow, id).toBe('1M context');
    }
  });

  it('getClaudeSdkEffort maps all 5 variants to correct effort levels (High default)', () => {
    expect(getClaudeSdkEffort('fable-5.1')).toBe('high');
    expect(getClaudeSdkEffort('fable-5.1-low')).toBe('low');
    expect(getClaudeSdkEffort('fable-5.1-medium')).toBe('medium');
    expect(getClaudeSdkEffort('fable-5.1-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('fable-5.1-max')).toBe('max');
  });

  it('never requests the 1M beta header (1M is native)', () => {
    for (const id of FABLE_5_1_VARIANTS) {
      expect(claudeModelRequires1M(id), id).toBe(false);
    }
  });

  it('surfaces before Fable 5 in the picker', () => {
    const families = CLAUDE_CODE_MODELS_CATALOG.map((m) => m.familyId);
    expect(families.indexOf('fable-5.1')).toBeLessThan(families.indexOf('fable-5'));
  });

  it('is live regardless of the fable5 launch flag (that flag gates Fable 5 only)', () => {
    expect(CLAUDE_CODE_MODELS.some((m) => m.familyId === 'fable-5.1')).toBe(true);
  });
});

describe('Fable 5 catalog (1M-beta, High default)', () => {
  const FABLE_5_VARIANTS = [
    'fable-5',
    'fable-5-low',
    'fable-5-medium',
    'fable-5-xhigh',
    'fable-5-max',
    'fable-5-1m',
    'fable-5-1m-low',
    'fable-5-1m-medium',
    'fable-5-1m-xhigh',
    'fable-5-1m-max',
  ];

  // Definition-shape assertions target the full _CATALOG so they validate the
  // dormant Fable 5 definition regardless of the launch flag.
  it('has exactly 10 variants plus Ultra twins: 5 efforts × 2 context tiers (full ladder incl. Max)', () => {
    const ids = CLAUDE_CODE_MODELS_CATALOG.filter((m) => m.familyId === 'fable-5' && !m.ultra).map(
      (m) => m.id,
    );
    expect(ids).toEqual(FABLE_5_VARIANTS);
  });

  it('pins every variant cliValue to claude-fable-5', () => {
    for (const id of FABLE_5_VARIANTS) {
      const model = CLAUDE_CODE_MODELS_CATALOG.find((m) => m.id === id);
      expect(model?.cliValue, id).toBe('claude-fable-5');
    }
  });

  it('getClaudeSdkEffort maps all 10 variants to correct effort levels (High default)', () => {
    expect(getClaudeSdkEffort('fable-5')).toBe('high');
    expect(getClaudeSdkEffort('fable-5-low')).toBe('low');
    expect(getClaudeSdkEffort('fable-5-medium')).toBe('medium');
    expect(getClaudeSdkEffort('fable-5-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('fable-5-max')).toBe('max');
    expect(getClaudeSdkEffort('fable-5-1m')).toBe('high');
    expect(getClaudeSdkEffort('fable-5-1m-low')).toBe('low');
    expect(getClaudeSdkEffort('fable-5-1m-medium')).toBe('medium');
    expect(getClaudeSdkEffort('fable-5-1m-xhigh')).toBe('xhigh');
    expect(getClaudeSdkEffort('fable-5-1m-max')).toBe('max');
  });

  it('1M variants trigger the 1M beta header; 200k variants do not', () => {
    for (const id of FABLE_5_VARIANTS) {
      expect(claudeModelRequires1M(id), id).toBe(id.includes('-1m'));
    }
  });

  it('surfaces before Opus 4.8 in the picker', () => {
    const families = CLAUDE_CODE_MODELS_CATALOG.map((m) => m.familyId);
    const fableIdx = families.indexOf('fable-5');
    const opusIdx = families.indexOf('opus-4.8');
    expect(fableIdx).toBeLessThan(opusIdx);
  });

  it('is gated out of the live catalog by the fable5 launch flag', () => {
    const live = CLAUDE_CODE_MODELS.some((m) => m.familyId === 'fable-5');
    expect(live).toBe(LAUNCH_FLAGS.fable5);
  });
});

const names = (families: { name: string }[]) => families.map((f) => f.name);

describe('splitNewestFamilies', () => {
  it('keeps the newest model of each line and folds the rest', () => {
    const { newest, older } = splitNewestFamilies([
      { id: 'a', name: 'Opus 5.5' },
      { id: 'b', name: 'Sonnet 5' },
      { id: 'c', name: 'Opus 4.8' },
      { id: 'd', name: 'GPT-6 Sol' },
      { id: 'e', name: 'GPT-5.6 Sol' },
    ]);
    expect(names(newest)).toEqual(['Opus 5.5', 'Sonnet 5', 'GPT-6 Sol']);
    expect(names(older)).toEqual(['Opus 4.8', 'GPT-5.6 Sol']);
  });

  // Pins what the page shows today, so a catalog edit shows up in review.
  it('splits the shipped catalogs as expected', () => {
    expect(names(splitNewestFamilies(CLAUDE_MODEL_FAMILIES).newest)).toEqual([
      'Fable 5.1',
      'Opus 5.5',
      'Sonnet 5.5',
      'Haiku 4.5',
    ]);
    expect(names(splitNewestFamilies(CODEX_MODEL_FAMILIES).newest)).toEqual([
      'GPT-6 Astra',
      'GPT-6.1 Sol',
      'GPT-6 Luna',
      'GPT-5.6 Terra',
      'GPT-5.5',
      'GPT-5.4 Mini',
    ]);
  });
});
