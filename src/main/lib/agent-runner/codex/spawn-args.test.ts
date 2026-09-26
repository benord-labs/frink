import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildCodexDynamicChatMcpUrl, buildSpawnArgs } from './spawn-args';

const base = {
  baseUrl: 'http://127.0.0.1:3111',
  subChatId: 'sub-a',
  projectPath: '/repo',
  mode: 'agent' as const,
  hasSignalTask: true,
};

describe('buildSpawnArgs', () => {
  const disabledFeatures = [
    '--disable',
    'computer_use',
    '--disable',
    'code_mode',
    '--disable',
    'code_mode_host',
    '--disable',
    'code_mode_buffered_exec',
    '--disable',
    'code_mode_only',
    '--disable',
    'multi_agent',
    '--disable',
    'multi_agent_v2',
  ];

  it('disables every unrouted execution surface before appending config args', () => {
    expect(buildSpawnArgs(['--config', 'x=1'])).toEqual([...disabledFeatures, '--config', 'x=1']);
    expect(buildSpawnArgs()).toEqual(disabledFeatures);
  });

  it('keeps the ordinary shell surfaces enabled while disabling the missing code-mode host', () => {
    const args = buildSpawnArgs();
    expect(args).toContain('code_mode_host');
    expect(args).not.toContain('shell_tool');
    expect(args).not.toContain('unified_exec');
  });
});

describe('buildCodexDynamicChatMcpUrl', () => {
  it('addresses a channel, never a per-run execution id', () => {
    const url = buildCodexDynamicChatMcpUrl(base);
    expect(url).toContain('channel=');
    expect(url).not.toContain('executionId');
  });

  it('is stable across turns of one sub-chat, so the warm server is reused', () => {
    expect(buildCodexDynamicChatMcpUrl(base)).toBe(buildCodexDynamicChatMcpUrl(base));
  });

  it('differs per sub-chat, so two chats never share one app-server', () => {
    expect(buildCodexDynamicChatMcpUrl(base)).not.toBe(
      buildCodexDynamicChatMcpUrl({ ...base, subChatId: 'sub-b' }),
    );
  });

  it('changes when the tool list would, so the registry respawns instead of serving a stale list', () => {
    const armed = buildCodexDynamicChatMcpUrl(base);
    expect(armed).not.toBe(buildCodexDynamicChatMcpUrl({ ...base, hasSignalTask: false }));
    expect(armed).not.toBe(buildCodexDynamicChatMcpUrl({ ...base, mode: 'plan' }));
  });

  it('returns no URL without a base URL or outside a project', () => {
    expect(buildCodexDynamicChatMcpUrl({ ...base, baseUrl: null })).toBeNull();
    expect(buildCodexDynamicChatMcpUrl({ ...base, projectPath: os.homedir() })).toBeNull();
  });
});
