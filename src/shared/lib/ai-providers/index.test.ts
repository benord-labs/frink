import { describe, expect, it } from 'vitest';
import { LAUNCH_FLAGS } from '../../launch-flags';
import { AI_PROVIDERS, aiProvider, runtimeFor, selectableProviderIds } from '.';

const ALL_ON = {
  codexAccounts: true,
  opencodeAccounts: true,
  copilotAccounts: true,
  grokAccounts: true,
};

describe('AI provider table', () => {
  it.each([
    ['claude-code', 'claude'],
    ['codex', 'codex'],
    ['opencode', 'acp'],
    ['copilot', 'acp'],
    ['grok', 'acp'],
  ] as const)('%s runs on %s with every flag on', (id, runtime) => {
    expect(aiProvider(id)).toEqual({ ...AI_PROVIDERS[id], id });
    expect(runtimeFor(id, ALL_ON, 'darwin')).toBe(runtime);
  });

  it('reads a missing type as Claude and an unknown type as no provider', () => {
    expect(aiProvider(null)?.id).toBe('claude-code');
    expect(aiProvider(undefined)?.id).toBe('claude-code');
    for (const type of ['github', 'cursor', '', 'toString']) {
      expect(aiProvider(type)).toBeUndefined();
      expect(runtimeFor(type, ALL_ON, 'darwin')).toBeUndefined();
    }
  });

  it('runs an agent only when its flag is on and this system is checked', () => {
    expect(runtimeFor('opencode', {}, 'darwin')).toBeUndefined();
    expect(runtimeFor('opencode', ALL_ON, 'win32')).toBeUndefined();
    expect(runtimeFor('opencode', ALL_ON)).toBeUndefined();
    expect(selectableProviderIds(ALL_ON, 'win32')).toEqual(['claude-code', 'codex']);
    expect(selectableProviderIds(ALL_ON, 'darwin')).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'copilot',
      'grok',
    ]);
  });

  it('uses the shipped flags when none are passed', () => {
    expect(runtimeFor('opencode', undefined, 'darwin')).toBe(
      LAUNCH_FLAGS.opencodeAccounts ? 'acp' : undefined,
    );
    expect(selectableProviderIds(undefined, 'darwin')).toEqual(
      selectableProviderIds(LAUNCH_FLAGS, 'darwin'),
    );
  });

  it('never gates running Codex on its picker flag', () => {
    expect(runtimeFor('codex', {})).toBe('codex');
    expect(selectableProviderIds({})).toEqual(['claude-code']);
  });
});
