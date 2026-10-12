import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from './db/schema';
import { buildMultiProjectToolsBlock, getMultiProjectContext } from './multi-project-prompt';

const listProjectsMock = vi.fn<() => Promise<Project[]>>();
vi.mock('./db', () => ({
  getDatabase: vi.fn(() => ({})),
}));
vi.mock('./db/repos/projects', () => ({
  // No `listProjects`: it includes virtual folders, and calling a missing mock export throws.
  listRealProjects: () => listProjectsMock(),
}));

const MCP_URL = 'http://127.0.0.1:12345';
const getOrStartDynamicChatMcpUrlMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => 'http://127.0.0.1:12345'),
);
vi.mock('./mcp/dynamic-chat-server', () => ({
  getOrStartDynamicChatMcpUrl: getOrStartDynamicChatMcpUrlMock,
}));

function makeProject(name: string, description: string | null): Project {
  return {
    id: `${name}-id`,
    name,
    description,
    path: `/tmp/${name}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    gitRemoteUrl: null,
    gitProvider: null,
    gitOwner: null,
    gitRepo: null,
    isCrossMachine: false,
  };
}

function makeLinkedProject(
  name: string,
  description: string | null,
  gitRemote: string,
  idSuffix: string,
): Project {
  return {
    ...makeProject(name, description),
    id: `${name}-${idSuffix}`,
    gitRemoteUrl: gitRemote,
  };
}

describe('buildMultiProjectToolsBlock', () => {
  it('uses accessible-project wording and broad switch guidance', () => {
    const prompt = buildMultiProjectToolsBlock([
      makeProject('frontend', 'User-facing web app'),
      makeProject('backend', 'API and data processing service'),
    ]);

    expect(prompt).toContain('projects that can be accessed in this session');
    expect(prompt).toContain('WHEN A DIFFERENT PROJECT CONTEXT MAY HELP');
    expect(prompt).toContain('behavior, data, configuration, or history');
    expect(prompt).toContain('full non-summarized list of accessible projects');
    expect(prompt).toContain('requestSwitchProject(project_id, worktree_path?)');
    expect(prompt).toContain('frink_navigation_context()');
  });

  it('summarizes descriptions and avoids full long text in prompt', () => {
    const longDescription =
      'This is a very long project description that should be truncated for prompt safety and to keep context usage low while still giving enough meaning to route investigations correctly across project boundaries.';
    const prompt = buildMultiProjectToolsBlock([
      makeProject('frontend', longDescription),
      makeProject('backend', 'API service'),
    ]);

    expect(prompt).toContain('"frontend" - This is a very long project description');
    expect(prompt).toContain('...');
    expect(prompt).not.toContain('route investigations correctly across project boundaries.');
    expect(prompt).toContain(
      'Use searchProjects/fetchAllProjects when you need fuller project metadata.',
    );
  });

  it('caps project summaries and shows that additional projects exist', () => {
    const projects = [
      makeProject('a', 'a'),
      makeProject('b', 'b'),
      makeProject('c', 'c'),
      makeProject('d', 'd'),
      makeProject('e', 'e'),
      makeProject('f', 'f'),
      makeProject('g', 'g'),
    ];

    const prompt = buildMultiProjectToolsBlock(projects);
    expect(prompt).toContain('(+1 more project(s); use tools for full list)');
  });

  it('deduplicates linked projects sharing the same gitRemoteUrl', () => {
    const prompt = buildMultiProjectToolsBlock([
      makeLinkedProject('frink', null, 'github.com/org/frink', 'a'),
      makeLinkedProject('frink', 'Primary codebase', 'github.com/org/frink', 'b'),
      makeProject('owners-web', 'owner portal'),
    ]);

    expect(prompt.match(/"frink"/g)?.length ?? 0).toBe(1);
    expect(prompt).toContain('"frink" - Primary codebase');
  });

  // Permissions overhaul ticket 01 added `isCrossMachine` to the Project row.
  // Guards against a future refactor switching to JSON.stringify(project) and
  // leaking storage-tier metadata into the agent prompt.
  it('does not leak isCrossMachine metadata into prompt output', () => {
    const prompt = buildMultiProjectToolsBlock([
      makeProject('frontend', 'web app'),
      makeProject('backend', 'api'),
    ]);
    expect(prompt).not.toContain('isCrossMachine');
    expect(prompt).not.toContain('is_cross_machine');
  });
});

describe('getMultiProjectContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrStartDynamicChatMcpUrlMock.mockResolvedValue(MCP_URL);
  });

  // sc-3854: a single-project user needs Frink's MCP (flows, task signal) as much as anyone.
  it.each([
    ['no projects', []],
    ['a single project', [makeProject('frontend', 'app')]],
  ])('mounts the MCP but omits the multi-project block with %s', async (_name, projects) => {
    listProjectsMock.mockResolvedValue(projects);

    const context = await getMultiProjectContext();
    expect(context).toEqual({ promptPrefix: '', dynamicChatMcpUrl: MCP_URL });
  });

  it('still mounts the MCP when the local project lookup fails', async () => {
    listProjectsMock.mockRejectedValue(new Error('local lookup failed'));

    const context = await getMultiProjectContext();
    expect(context).toEqual({ promptPrefix: '', dynamicChatMcpUrl: MCP_URL });
  });

  it('adds the multi-project block at exactly two projects, alongside the MCP', async () => {
    listProjectsMock.mockResolvedValue([makeProject('frontend', 'app'), makeProject('api', 'api')]);

    const context = await getMultiProjectContext();
    expect(context.promptPrefix).toContain('<multi_project_tools>');
    expect(context.dynamicChatMcpUrl).toBe(MCP_URL);
  });

  it('reports no MCP when its server fails to start, without throwing', async () => {
    listProjectsMock.mockResolvedValue([makeProject('frontend', 'app')]);
    getOrStartDynamicChatMcpUrlMock.mockRejectedValueOnce(new Error('EADDRINUSE'));

    const context = await getMultiProjectContext();
    expect(context).toEqual({ promptPrefix: '', dynamicChatMcpUrl: null });
  });

  it('shares one server start between concurrent chats (a pre-warm racing its send)', async () => {
    listProjectsMock.mockResolvedValue([makeProject('frontend', 'app')]);
    let finishStart: (url: string) => void = () => {};
    getOrStartDynamicChatMcpUrlMock.mockImplementationOnce(
      () => new Promise((resolve) => (finishStart = resolve)),
    );

    const pending = Promise.all([getMultiProjectContext(), getMultiProjectContext()]);
    await vi.waitFor(() => expect(getOrStartDynamicChatMcpUrlMock).toHaveBeenCalled());
    finishStart(MCP_URL);
    const [prewarm, send] = await pending;

    expect(getOrStartDynamicChatMcpUrlMock).toHaveBeenCalledTimes(1);
    expect(prewarm.dynamicChatMcpUrl).toBe(MCP_URL);
    expect(send.dynamicChatMcpUrl).toBe(MCP_URL);
  });

  it('retries the start on the next chat after a failed one', async () => {
    listProjectsMock.mockResolvedValue([makeProject('frontend', 'app')]);
    getOrStartDynamicChatMcpUrlMock.mockResolvedValueOnce(null);

    expect((await getMultiProjectContext()).dynamicChatMcpUrl).toBeNull();
    expect((await getMultiProjectContext()).dynamicChatMcpUrl).toBe(MCP_URL);
    expect(getOrStartDynamicChatMcpUrlMock).toHaveBeenCalledTimes(2);
  });

  it('includes current project/worktree context block when provided', async () => {
    listProjectsMock.mockResolvedValue([
      makeProject('frontend', 'frontend app'),
      makeProject('backend', 'backend api'),
    ]);

    const context = await getMultiProjectContext({
      name: 'frontend',
      id: 'frontend-id',
      path: '/tmp/frontend',
      worktreePath: '/tmp/worktrees/frontend/feat-x',
      branch: 'feat-x',
    });

    expect(context.promptPrefix).toContain('<current_context>');
    expect(context.promptPrefix).toContain('Project: "frontend" (id: frontend-id)');
    expect(context.promptPrefix).toContain('Path: /tmp/worktrees/frontend/feat-x');
    expect(context.promptPrefix).toContain('Branch: feat-x');
    expect(context.promptPrefix).toContain('Worktree: yes');
  });
});
