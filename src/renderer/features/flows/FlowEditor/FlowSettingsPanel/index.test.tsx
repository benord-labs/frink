// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { fastModeDescription } from '.';

vi.mock('../../../../lib/trpc', () => ({ trpc: {} }));

describe('fastModeDescription', () => {
  it('labels speed and the selected model ChatGPT credit multiplier separately', () => {
    expect(fastModeDescription('codex-gpt-5.6-sol-medium')).toBe(
      'Runs Agent steps at 1.5× model speed for 2.5× ChatGPT credits per turn. API-key pricing differs.',
    );
    expect(fastModeDescription('codex-gpt-5.4-medium')).toContain(
      '1.5× model speed for 2× ChatGPT credits',
    );
  });

  it('does not promise Fast for an unsupported or unspecified default model', () => {
    expect(fastModeDescription('codex-gpt-5.4-mini-medium')).toContain(
      'The default model has no Fast tier.',
    );
    expect(fastModeDescription(undefined)).toContain('Applies only to supported OpenAI models.');
  });
});
