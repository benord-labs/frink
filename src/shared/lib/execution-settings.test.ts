import { describe, expect, it } from 'vitest';
import {
  buildExecutionSettings,
  COMPOSER_DEFAULTS,
  type ComposerSettings,
  resolveComposerSettings,
} from './execution-settings';

const SUPPORTED = 'codex-gpt-5.6-sol-medium';
const NO_TIER = 'codex-gpt-5.4-mini-medium';

const settings = (over: Partial<ComposerSettings> = {}): ComposerSettings => ({
  ...COMPOSER_DEFAULTS,
  ...over,
});

describe('resolveComposerSettings', () => {
  it('falls back to the defaults for values nobody set', () => {
    expect(resolveComposerSettings({ modelId: null, autoMode: null }, undefined)).toEqual(
      COMPOSER_DEFAULTS,
    );
  });

  it('keeps stored values, including an explicit off', () => {
    expect(
      resolveComposerSettings({ modelId: 'opus-4.8', autoMode: false, codexSpeed: 'fast' }, false),
    ).toEqual({
      modelId: 'opus-4.8',
      autoMode: false,
      codexSpeed: 'fast',
      thinkingEnabled: false,
    });
  });

  it('never defaults Fast on — the tier bills a credit multiplier', () => {
    expect(resolveComposerSettings({}, true).codexSpeed).toBe('standard');
  });
});

describe('buildExecutionSettings', () => {
  it('sends the thinking budget and effort only while Thinking is on (Claude)', () => {
    const on = buildExecutionSettings('claude-code', settings({ modelId: 'opus-4.8-max' }));
    expect(on.maxThinkingTokens).toBeGreaterThan(0);
    expect(on.effort).toBe('max');

    const off = buildExecutionSettings(
      'claude-code',
      settings({ modelId: 'opus-4.8-max', thinkingEnabled: false }),
    );
    expect(off.maxThinkingTokens).toBeUndefined();
    expect(off.effort).toBeUndefined();
  });

  it('never sends a thinking budget to Codex', () => {
    expect(
      buildExecutionSettings('codex', settings({ modelId: SUPPORTED })).maxThinkingTokens,
    ).toBe(undefined);
  });

  it('maps the picker id to the CLI model for Claude and forwards it raw for Codex', () => {
    expect(buildExecutionSettings('claude-code', settings({ modelId: 'opus-4.8' })).model).toBe(
      'claude-opus-4-8',
    );
    expect(buildExecutionSettings('codex', settings({ modelId: SUPPORTED })).model).toBe(SUPPORTED);
  });

  it('turns on the 1M beta only for a Claude 1M variant', () => {
    expect(
      buildExecutionSettings('claude-code', settings({ modelId: 'opus-4.7-1m-high' })).betas,
    ).toEqual(['context-1m-2025-08-07']);
    expect(buildExecutionSettings('claude-code', settings()).betas).toBeUndefined();
  });

  it('asks for the Auto reviewer only when the chat opted in and the model has one', () => {
    expect(buildExecutionSettings('claude-code', settings()).autoReviewTools).toBe(true);
    expect(
      buildExecutionSettings('claude-code', settings({ autoMode: false })).autoReviewTools,
    ).toBeUndefined();
    expect(
      buildExecutionSettings('claude-code', settings({ modelId: 'haiku' })).autoReviewTools,
    ).toBeUndefined();
  });

  it('carries enableTasks only when the caller supplies it', () => {
    expect(buildExecutionSettings('claude-code', settings())).not.toHaveProperty('enableTasks');
    expect(
      buildExecutionSettings('claude-code', settings(), { enableTasks: false }).enableTasks,
    ).toBe(false);
  });

  describe('Codex Fast', () => {
    it('sends the flag only when the chat has Fast on', () => {
      expect(buildExecutionSettings('codex', settings({ modelId: SUPPORTED })).codexSpeed).toBe(
        'standard',
      );
      expect(
        buildExecutionSettings('codex', settings({ modelId: SUPPORTED, codexSpeed: 'fast' }))
          .codexSpeed,
      ).toBe('fast');
    });

    it('omits the flag entirely for models with no priority tier', () => {
      // A chat left on Fast then switched to a tier-less model must not ask for a tier at all.
      const sent = buildExecutionSettings(
        'codex',
        settings({ modelId: NO_TIER, codexSpeed: 'fast' }),
      );
      expect(sent).not.toHaveProperty('codexSpeed');
    });

    it('omits the flag for a stale or cross-provider id instead of snapping to a default', () => {
      // A dropped id resolves to no multiplier, so the request asks for nothing rather than betting
      // the executor's fallback slug happens to be free.
      for (const modelId of ['codex-gpt-5.3-codex-high', 'opus-4.8', 'cursor-codex-5.3-high']) {
        const sent = buildExecutionSettings('codex', settings({ modelId, codexSpeed: 'fast' }));
        expect(sent).not.toHaveProperty('codexSpeed');
      }
    });
  });
});
