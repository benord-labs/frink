import fs from 'node:fs';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MCP_URL = vi.hoisted(() => 'http://127.0.0.1:4312');
const mocks = vi.hoisted(() => ({
  getMultiProjectContext: vi.fn(
    async (): Promise<{ promptPrefix: string; dynamicChatMcpUrl: string | null }> => ({
      promptPrefix: '',
      dynamicChatMcpUrl: MCP_URL,
    }),
  ),
  getOrStartDynamicChatMcpUrl: vi.fn(async (): Promise<string | null> => MCP_URL),
}));

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../multi-project-prompt', () => ({
  getMultiProjectContext: mocks.getMultiProjectContext,
}));
vi.mock('../../mcp/dynamic-chat-server', () => ({
  getOrStartDynamicChatMcpUrl: mocks.getOrStartDynamicChatMcpUrl,
}));
vi.mock('../../permissions', () => ({
  resolvePermissionProjectPath: (worktreePath: string) => `perm:${worktreePath}`,
}));

import { resolveChatWorkspace } from './chat-workspace';

const PROJECT = { id: 'p1', name: 'solo', path: '/repo/solo' };

describe('resolveChatWorkspace — Frink MCP mount (sc-3854)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    mocks.getMultiProjectContext.mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: MCP_URL,
    });
    mocks.getOrStartDynamicChatMcpUrl.mockResolvedValue(MCP_URL);
  });

  it('mounts the MCP for a single-project agent chat with no multi-project block', async () => {
    const workspace = await resolveChatWorkspace(PROJECT, { branch: 'main' }, 'agent');

    expect(workspace.dynamicChatMcpUrl).toBe(MCP_URL);
    expect(workspace.multiProjectPrefix).toBe('');
    expect(mocks.getOrStartDynamicChatMcpUrl).not.toHaveBeenCalled();
  });

  it('mounts the MCP for a general chat with no project, running in home', async () => {
    const workspace = await resolveChatWorkspace(null, null, 'agent');

    expect(workspace.projectPath).toBe(os.homedir());
    expect(workspace.dynamicChatMcpUrl).toBe(MCP_URL);
    expect(mocks.getMultiProjectContext).toHaveBeenCalledWith(undefined);
  });

  it('keeps the MCP when the chat worktree is missing on disk and cwd falls back', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p !== '/wt/gone');

    const workspace = await resolveChatWorkspace(
      PROJECT,
      { worktreePath: '/wt/gone', branch: 'feat' },
      'agent',
    );

    expect(workspace.projectPath).toBe(PROJECT.path);
    expect(workspace.permissionProjectPath).toBe(PROJECT.path);
    expect(workspace.dynamicChatMcpUrl).toBe(MCP_URL);
  });

  it('reports no MCP in agent mode when the start failed, without a second attempt', async () => {
    mocks.getMultiProjectContext.mockResolvedValue({ promptPrefix: '', dynamicChatMcpUrl: null });

    const workspace = await resolveChatWorkspace(PROJECT, null, 'agent');

    expect(workspace.dynamicChatMcpUrl).toBeNull();
    expect(mocks.getOrStartDynamicChatMcpUrl).not.toHaveBeenCalled();
  });

  it('retries a failed start once in plan mode', async () => {
    mocks.getMultiProjectContext.mockResolvedValue({ promptPrefix: '', dynamicChatMcpUrl: null });

    const workspace = await resolveChatWorkspace(PROJECT, null, 'plan');

    expect(workspace.dynamicChatMcpUrl).toBe(MCP_URL);
    expect(mocks.getOrStartDynamicChatMcpUrl).toHaveBeenCalledTimes(1);
  });
});
