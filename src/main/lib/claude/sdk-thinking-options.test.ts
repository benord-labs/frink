import { describe, expect, it } from 'vitest';
import { buildClaudeSdkThinkingPartial } from './sdk-thinking-options';

describe('buildClaudeSdkThinkingPartial', () => {
  it('returns empty when thinking is off', () => {
    expect(buildClaudeSdkThinkingPartial(undefined)).toEqual({});
    expect(buildClaudeSdkThinkingPartial({ maxThinkingTokens: undefined })).toEqual({});
    expect(buildClaudeSdkThinkingPartial({ maxThinkingTokens: 0 })).toEqual({});
  });

  it('uses adaptive with display=summarized for claude-opus-4-7 so the Thought panel renders', () => {
    // Opus 4.7 defaults `display` to `omitted`, which streams empty thinking blocks and
    // leaves Frink's UI Thought panel blank. `summarized` restores visible reasoning.
    expect(
      buildClaudeSdkThinkingPartial({
        model: 'claude-opus-4-7',
        maxThinkingTokens: 32_000,
      }),
    ).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });

  it('uses adaptive with display=summarized for claude-opus-4-8 (same adaptive-only path as 4.7)', () => {
    expect(
      buildClaudeSdkThinkingPartial({
        model: 'claude-opus-4-8',
        maxThinkingTokens: 60_000,
      }),
    ).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });

  it('uses adaptive with display=summarized for claude-opus-5 (manual budget_tokens would 400)', () => {
    expect(
      buildClaudeSdkThinkingPartial({
        model: 'claude-opus-5',
        maxThinkingTokens: 60_000,
      }),
    ).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });

  it('uses adaptive with display=summarized for claude-fable-5-1 (manual budget_tokens would 400)', () => {
    expect(
      buildClaudeSdkThinkingPartial({
        model: 'claude-fable-5-1',
        maxThinkingTokens: 32_000,
      }),
    ).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });

  it('uses adaptive with display=summarized for claude-fable-5 (prevents blank Thought panel)', () => {
    expect(
      buildClaudeSdkThinkingPartial({
        model: 'claude-fable-5',
        maxThinkingTokens: 32_000,
      }),
    ).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });

  it('uses adaptive with display=summarized for claude-sonnet-5 (manual budget_tokens would 400)', () => {
    expect(
      buildClaudeSdkThinkingPartial({
        model: 'claude-sonnet-5',
        maxThinkingTokens: 30_000,
      }),
    ).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });

  it('uses enabled + budgetTokens for other Claude models (CLI --max-thinking-tokens)', () => {
    expect(
      buildClaudeSdkThinkingPartial({
        model: 'claude-opus-4-6',
        maxThinkingTokens: 32_000,
      }),
    ).toEqual({ thinking: { type: 'enabled', budgetTokens: 32_000 } });
    expect(
      buildClaudeSdkThinkingPartial({
        model: 'sonnet',
        maxThinkingTokens: 32_000,
      }),
    ).toEqual({ thinking: { type: 'enabled', budgetTokens: 32_000 } });
  });
});
