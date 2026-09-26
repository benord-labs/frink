import { describe, expect, it } from 'vitest';
import {
  CODEX_MODEL_PREFIX,
  isFlowModelIncompatibleWithProjectProvider,
} from './project-model-affinity';

describe('CODEX_MODEL_PREFIX', () => {
  it('matches codex-prefixed model ids', () => {
    expect('codex-gpt-5.3-codex-high'.startsWith(CODEX_MODEL_PREFIX)).toBe(true);
    expect('sonnet'.startsWith(CODEX_MODEL_PREFIX)).toBe(false);
  });
});

describe('isFlowModelIncompatibleWithProjectProvider', () => {
  it.each([
    // empty / unknown-provider → never clears (no spurious incompatible)
    [undefined, 'unknown', false],
    ['', 'claude-code', false],
    ['sonnet', 'unknown', false],
    // each project provider accepts only its own namespace
    ['codex-gpt-5.3-codex-high', 'claude-code', true],
    ['haiku', 'claude-code', false],
    ['codex-gpt-5.3-codex-high', 'codex', false],
    ['sonnet', 'codex', true],
    // an id this build no longer lists is left alone rather than silently cleared
    ['opus-4.5', 'claude-code', false],
    ['cursor-gpt-5.2', 'claude-code', false],
  ] as const)('model=%s on a %s project → incompatible=%s', (model, provider, expected) => {
    expect(isFlowModelIncompatibleWithProjectProvider(model, provider)).toBe(expected);
  });
});
