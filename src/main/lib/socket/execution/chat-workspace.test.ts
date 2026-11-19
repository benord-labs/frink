import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../db/schema';
import { freshDb } from '../../db/test-utils/fresh-db';
import { gitAsTestUser as git } from '../../test-utils/git-as-test-user';
import { makeLocalChat } from '../../trpc/routers/chats/test-factories';

const MCP_URL = vi.hoisted(() => 'http://127.0.0.1:4312');
const mocks = vi.hoisted(() => ({
  getMultiProjectContext: vi.fn(
    async (): Promise<{ promptPrefix: string; dynamicChatMcpUrl: string | null }> => ({
      promptPrefix: '',
      dynamicChatMcpUrl: MCP_URL,
    }),
  ),
  getOrStartDynamicChatMcpUrl: vi.fn(async (): Promise<string | null> => MCP_URL),
  getDatabase: vi.fn(),
  resolvePermissionProjectPath: vi.fn((worktreePath: string) => `perm:${worktreePath}`),
}));

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../multi-project-prompt', () => ({
  getMultiProjectContext: mocks.getMultiProjectContext,
}));
vi.mock('../../mcp/dynamic-chat-server', () => ({
  getOrStartDynamicChatMcpUrl: mocks.getOrStartDynamicChatMcpUrl,
}));
vi.mock('../../db', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../permissions', () => ({
  resolvePermissionProjectPath: mocks.resolvePermissionProjectPath,
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
    const workspace = await resolveChatWorkspace(PROJECT, { id: 'c1', branch: 'main' }, 'agent');

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
      { id: 'c1', worktreePath: '/wt/gone', branch: 'feat' },
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

    const workspace = await resolveChatWorkspace(
      PROJECT,
      { id: 'c1', worktreePath: worktree },
      'agent',
    );

    expect(workspace.projectPath).toBe(worktree);
    expect(workspace.projectConfigRoot).toBe(repo);
  });

  it('is not set for a chat in the project folder', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const workspace = await resolveChatWorkspace(PROJECT, { id: 'c1', branch: 'main' }, 'agent');

    expect(workspace.projectConfigRoot).toBeUndefined();
  });
});

describe('the projects linked to the chat, as its agent is told about them', () => {
  // Made in beforeAll, so a run that filters out every case here leaves no folder behind.
  let root = '';
  let db: ReturnType<typeof freshDb>;
  // Real folders, or a virtual folder as written.
  const place = (folder: string) => (folder.includes('://') ? folder : path.join(root, folder));
  const mainProject = () => ({ id: 'main', name: 'main', path: place('main') });
  const link = (id: string, folder: string, name = id) => {
    db.insert(schema.projects)
      .values({ id, name, path: place(folder) })
      .run();
    db.insert(schema.chatLinkedProjects).values({ chatId: 'c1', projectId: id }).run();
  };
  // A worktree chat: the agent runs in wt, and permissions are judged against main.
  const linked = async (project: Parameters<typeof resolveChatWorkspace>[0] = mainProject()) =>
    (await resolveChatWorkspace(project, { id: 'c1', worktreePath: place('wt') }, 'agent'))
      .linkedProjects;

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'frink-linked-ws-')));
    for (const folder of ['main/pkg', 'wt/pkg', 'libs/a', 'libs/b', 'libs/z']) {
      fs.mkdirSync(place(folder), { recursive: true });
    }
    fs.symlinkSync(place('main'), place('main-alias'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    db = freshDb();
    db.insert(schema.projects).values(mainProject()).run();
    db.insert(schema.chats)
      .values(makeLocalChat({ id: 'c1', projectId: 'main', worktreePath: place('wt') }))
      .run();
    mocks.getDatabase.mockReturnValue(db);
    mocks.resolvePermissionProjectPath.mockReturnValue(place('main'));
  });
  afterEach(() => mocks.resolvePermissionProjectPath.mockReset());

  it.each([
    ['is missing on disk', 'gone'],
    ['is a virtual folder', 'virtual://x'],
    ['is the worktree', 'wt'],
    ['is inside the worktree', 'wt/pkg'],
    ['is the main checkout, by another name', 'main-alias'],
    ['is inside the main checkout', 'main/pkg'],
    ['holds both', ''],
  ])('leaves out a project whose folder %s', async (_case, folder) => {
    link('x', folder);
    expect(await linked()).toEqual([]);
  });

  it('lists the rest by name, then path, with their full paths', async () => {
    link('b', 'libs/b');
    link('z', 'libs/z', 'a');
    link('a', 'libs/a');
    expect(await linked()).toEqual([
      { name: 'a', path: place('libs/a') },
      { name: 'a', path: place('libs/z') },
      { name: 'b', path: place('libs/b') },
    ]);
  });

  it.each([
    ['a general chat', null],
    ['a chat in a virtual folder', { id: 'v', name: 'v', path: 'virtual://v' }],
  ])('names none for %s', async (_case, project) => {
    link('a', 'libs/a');
    expect(await linked(project)).toEqual([]);
  });

  it('names none, with a warning, when the links cannot be read', async () => {
    mocks.getDatabase.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    expect(await linked()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('linked projects'),
      expect.any(Error),
    );
  });
});
