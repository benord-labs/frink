import { describe, expect, it } from 'vitest';
import {
  resolveExecutionModelCliString,
  supportsNativeAutoReview,
} from './resolve-execution-model-cli';

describe('resolveExecutionModelCliString', () => {
  it('maps Claude account + sonnet id to sonnet CLI', () => {
    expect(resolveExecutionModelCliString('claude-code', 'sonnet')).toBe('sonnet');
  });

  it('maps Claude account + thinking variant to version-pinned Opus CLI id', () => {
    expect(resolveExecutionModelCliString('claude-code', 'opus-1m-high')).toBe('claude-opus-4-6');
    expect(resolveExecutionModelCliString('claude-code', 'opus-4.7-1m-high')).toBe(
      'claude-opus-4-7',
    );
  });

  it('maps Claude account + Opus 4.8 (1M-native, no -1m variant) to claude-opus-4-8', () => {
    expect(resolveExecutionModelCliString('claude-code', 'opus-4.8')).toBe('claude-opus-4-8');
    expect(resolveExecutionModelCliString('claude-code', 'opus-4.8-max')).toBe('claude-opus-4-8');
  });

  // Codex forwards the picker id RAW — slug + turn-scoped effort split happens at the executor
  // (resolveCodexCliModel), which also maps an unknown/cross-provider id to its default slug + effort.
  it.each(['codex-gpt-5.3-codex-high', 'sonnet', 'opus-4.8'])(
    'codex account forwards %s unchanged (no early coercion here)',
    (id) => {
      expect(resolveExecutionModelCliString('codex', id)).toBe(id);
    },
  );
});

describe('supportsNativeAutoReview', () => {
  it.each(['sonnet', 'opus-4.7', 'opus-4.8'])('supports current Claude model %s', (model) => {
    expect(supportsNativeAutoReview('claude-code', model)).toBe(true);
  });

  it.each(['haiku', 'claude-3-haiku', 'claude-sonnet-4-5'])(
    'rejects unsupported Claude model %s',
    (model) => {
      expect(supportsNativeAutoReview('claude-code', model)).toBe(false);
    },
  );

  it('supports Codex', () => {
    expect(supportsNativeAutoReview('codex', 'codex-gpt-5.3-codex-high')).toBe(true);
  });

  it('fails closed when the selected Claude model has not loaded', () => {
    expect(supportsNativeAutoReview('claude-code', undefined)).toBe(false);
  });
});
