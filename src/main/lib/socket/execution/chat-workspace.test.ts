import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitAsTestUser as git } from '../../test-utils/git-as-test-user';

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

import { claudeProjectConfigRoot, resolveChatWorkspace } from './chat-workspace';

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

describe('the main checkout Claude reads a worktree chat project config from', () => {
  let tmpRoot: string;
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'frink-config-root-')));
    repo = path.join(tmpRoot, 'repo');
    worktree = path.join(tmpRoot, 'worktrees', 'feature');
    git(tmpRoot, 'init', '-q', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', worktree);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('is the git main checkout of a Frink-managed worktree', () => {
    expect(claudeProjectConfigRoot(worktree, '/projects/repo')).toBe(repo);
  });

  it('is not set for a folder Frink does not manage as a worktree', () => {
    expect(claudeProjectConfigRoot(worktree, worktree)).toBeUndefined();
  });

  it('is not set when the worktree no longer links to a main checkout', () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });

    expect(claudeProjectConfigRoot(worktree, '/projects/repo')).toBeUndefined();
  });

  it('is not set for a folder that is not a linked worktree', () => {
    expect(claudeProjectConfigRoot(repo, '/projects/repo')).toBeUndefined();
  });

  it('reaches the workspace of a chat running in the worktree', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const workspace = await resolveChatWorkspace(PROJECT, { worktreePath: worktree }, 'agent');

    expect(workspace.projectPath).toBe(worktree);
    expect(workspace.projectConfigRoot).toBe(repo);
  });

  it('is not set for a chat in the project folder', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const workspace = await resolveChatWorkspace(PROJECT, { branch: 'main' }, 'agent');

    expect(workspace.projectConfigRoot).toBeUndefined();
  });
});
