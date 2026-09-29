// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { fastModeDescription, ultrafastDescription } from '.';

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

describe('ultrafastDescription', () => {
  it('states the unattended cost on a model that offers it, and plain standard speed otherwise', () => {
    expect(ultrafastDescription(8)).toContain('up to 8× faster for 8× ChatGPT credits');
    expect(ultrafastDescription(8)).toContain('even when nobody is watching');
    expect(ultrafastDescription(null)).toBe(
      'The default model has no Ultrafast tier, so steps run at standard speed.',
    );
  });
});
