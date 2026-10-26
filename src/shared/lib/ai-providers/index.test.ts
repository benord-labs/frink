import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  agentRunnable,
  aiProvider,
  isInstalledAgent,
  runtimeFor,
  selectableProviderIds,
  unsupportedModeMessage,
  unsupportedModes,
} from '.';

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

  it('marks OpenCode, GitHub Copilot and Cursor as Preview, and nothing else', () => {
    expect(AI_PROVIDER_IDS.filter((id) => aiProvider(id)?.preview)).toEqual([
      'opencode',
      'copilot',
      'cursor',
    ]);
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

  it('ships OpenCode, GitHub Copilot and Cursor on macOS and Linux, and Grok off', () => {
    expect(runtimeFor('opencode', undefined, 'darwin')).toBe('acp');
    expect(runtimeFor('opencode', undefined, 'linux')).toBe('acp');
    expect(runtimeFor('opencode', undefined, 'win32')).toBeUndefined();
    expect(runtimeFor('copilot', undefined, 'darwin')).toBe('copilot');
    expect(runtimeFor('copilot', undefined, 'linux')).toBe('copilot');
    expect(runtimeFor('copilot', undefined, 'win32')).toBeUndefined();
    expect(runtimeFor('cursor', undefined, 'darwin')).toBe('cursor');
    expect(runtimeFor('cursor', undefined, 'linux')).toBe('cursor');
    expect(runtimeFor('cursor', undefined, 'win32')).toBeUndefined();
    expect(runtimeFor('grok', undefined, 'darwin')).toBeUndefined();
    expect(selectableProviderIds(undefined, 'darwin')).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'copilot',
      'cursor',
    ]);
    expect(selectableProviderIds(undefined, 'linux')).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'copilot',
      'cursor',
    ]);
  });

  it('turns each installed agent on per operating system from its own row', () => {
    const openCodeOnLinux = { ...AI_PROVIDERS.opencode, platforms: ['darwin', 'linux'] };
    expect(agentRunnable(openCodeOnLinux, ALL_ON, 'linux')).toBe(true);
    expect(agentRunnable(AI_PROVIDERS.grok, ALL_ON, 'linux')).toBe(false);
    expect(agentRunnable(AI_PROVIDERS.grok, ALL_ON, 'darwin')).toBe(true);
    expect(agentRunnable(openCodeOnLinux, {}, 'linux')).toBe(false);
    expect(agentRunnable(openCodeOnLinux, ALL_ON)).toBe(false);
  });

  it('runs GitHub Copilot on its own runtime only when its flag is on and this system is checked', () => {
    expect(runtimeFor('copilot', {}, 'darwin')).toBeUndefined();
    expect(runtimeFor('copilot', { copilotAccounts: true }, 'win32')).toBeUndefined();
    expect(runtimeFor('copilot', { copilotAccounts: true }, 'darwin')).toBe('copilot');
    expect(selectableProviderIds({ copilotAccounts: true }, 'linux')).toEqual([
      'claude-code',
      'copilot',
    ]);
    expect(selectableProviderIds({ copilotAccounts: true }, 'darwin')).toEqual([
      'claude-code',
      'copilot',
    ]);
  });

  it('runs Cursor on its own runtime only when its flag is on and this system is checked', () => {
    expect(runtimeFor('cursor', {}, 'darwin')).toBeUndefined();
    expect(runtimeFor('cursor', { cursorAccounts: true }, 'win32')).toBeUndefined();
    expect(runtimeFor('cursor', { cursorAccounts: true }, 'darwin')).toBe('cursor');
    expect(runtimeFor('cursor', { cursorAccounts: true }, 'linux')).toBe('cursor');
  });

  it('never gates running Codex on its picker flag', () => {
    expect(runtimeFor('codex', {})).toBe('codex');
    expect(selectableProviderIds({})).toEqual(['claude-code']);
  });
});

describe('unsupportedModes', () => {
  it.each([
    ['claude-code', []],
    [undefined, []],
    ['codex', ['plan', 'debug']],
    ['opencode', ['debug']],
    ['copilot', ['debug']],
    ['cursor', ['debug']],
    ['grok', ['plan', 'debug']],
    ['not-a-provider', []],
  ] as const)('%s has no equivalent for %j', (id, modes) => {
    expect(unsupportedModes(id)).toEqual(modes);
  });

  it('names the mode and provider a turn cannot run on', () => {
    expect(unsupportedModeMessage('codex', 'plan')).toBe(
      "Plan mode isn't available for OpenAI yet.",
    );
    expect(unsupportedModeMessage('grok', 'debug')).toBe(
      "Debug mode isn't available for Grok yet.",
    );
    expect(unsupportedModeMessage('codex', 'debug')).toBe(
      "Debug mode isn't available for OpenAI yet.",
    );
  });

  it.each([
    ['codex', 'agent'],
    ['claude-code', 'plan'],
    ['opencode', 'plan'],
  ] as const)('lets %s run %s', (id, mode) => {
    expect(unsupportedModeMessage(id, mode)).toBeNull();
  });
});
