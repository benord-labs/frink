import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, aiProvider, isInstalledAgent, runtimeFor, selectableProviderIds } from '.';

const ALL_ON = {
  codexAccounts: true,
  opencodeAccounts: true,
  copilotAccounts: true,
  cursorAccounts: true,
  grokAccounts: true,
};

describe('AI provider table', () => {
  it.each([
    ['claude-code', 'claude'],
    ['codex', 'codex'],
    ['opencode', 'acp'],
    ['copilot', 'copilot'],
    ['cursor', 'cursor'],
    ['grok', 'acp'],
  ] as const)('%s runs on %s with every flag on', (id, runtime) => {
    expect(aiProvider(id)).toEqual({ ...AI_PROVIDERS[id], id });
    expect(runtimeFor(id, ALL_ON, 'darwin')).toBe(runtime);
  });

  it('counts every provider but Claude and OpenAI as an installed agent, whatever runs it', () => {
    const agents = Object.values(AI_PROVIDERS).filter((row) => isInstalledAgent(row));
    expect(agents.map((row) => row.name)).toEqual(['OpenCode', 'GitHub Copilot', 'Cursor', 'Grok']);
    expect(isInstalledAgent(aiProvider('unknown'))).toBe(false);
  });

  it('reads a missing type as Claude and an unknown type as no provider', () => {
    expect(aiProvider(null)?.id).toBe('claude-code');
    expect(aiProvider(undefined)?.id).toBe('claude-code');
    for (const type of ['github', 'cursor-cli', '', 'toString']) {
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
      'cursor',
      'grok',
    ]);
  });

  it('ships OpenCode and GitHub Copilot on macOS only, and Grok off', () => {
    expect(runtimeFor('opencode', undefined, 'darwin')).toBe('acp');
    expect(runtimeFor('opencode', undefined, 'linux')).toBeUndefined();
    expect(runtimeFor('copilot', undefined, 'darwin')).toBe('copilot');
    expect(runtimeFor('copilot', undefined, 'linux')).toBeUndefined();
    expect(runtimeFor('copilot', undefined, 'win32')).toBeUndefined();
    expect(runtimeFor('grok', undefined, 'darwin')).toBeUndefined();
    expect(selectableProviderIds(undefined, 'darwin')).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'copilot',
    ]);
    expect(selectableProviderIds(undefined, 'linux')).toEqual(['claude-code', 'codex']);
  });

  it('runs GitHub Copilot on its own runtime only when its flag is on and this system is checked', () => {
    expect(runtimeFor('copilot', {}, 'darwin')).toBeUndefined();
    expect(runtimeFor('copilot', { copilotAccounts: true }, 'win32')).toBeUndefined();
    expect(runtimeFor('copilot', { copilotAccounts: true }, 'darwin')).toBe('copilot');
    expect(selectableProviderIds({ copilotAccounts: true }, 'linux')).toEqual(['claude-code']);
    expect(selectableProviderIds({ copilotAccounts: true }, 'darwin')).toEqual([
      'claude-code',
      'copilot',
    ]);
  });

  it('keeps Cursor off as shipped, and runs it on macOS only once its flag is on', () => {
    expect(runtimeFor('cursor', undefined, 'darwin')).toBeUndefined();
    expect(selectableProviderIds(undefined, 'darwin')).not.toContain('cursor');
    expect(runtimeFor('cursor', { cursorAccounts: true }, 'win32')).toBeUndefined();
    expect(runtimeFor('cursor', { cursorAccounts: true }, 'darwin')).toBe('cursor');
  });

  it('never gates running Codex on its picker flag', () => {
    expect(runtimeFor('codex', {})).toBe('codex');
    expect(selectableProviderIds({})).toEqual(['claude-code']);
  });
});
