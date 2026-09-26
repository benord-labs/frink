import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from './db/schema';
import { buildMultiProjectToolsBlock, getMultiProjectContext } from './multi-project-prompt';

const listProjectsMock = vi.fn<() => Promise<Project[]>>();
vi.mock('./db', () => ({
  getDatabase: vi.fn(() => ({})),
}));
vi.mock('./db/repos/projects', () => ({
  listProjects: (...args: unknown[]) => listProjectsMock(...(args as [])),
}));

vi.mock('./mcp/dynamic-chat-server', () => ({
  getOrStartDynamicChatMcpUrl: vi.fn(async () => 'http://127.0.0.1:12345'),
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
  });

  it('returns empty context when fewer than two local projects exist', async () => {
    listProjectsMock.mockResolvedValue([makeProject('frontend', 'app')]);

    const context = await getMultiProjectContext();
    expect(context).toEqual({ promptPrefix: '', dynamicChatMcpUrl: null });
  });

  it('returns empty context when local lookup fails', async () => {
    listProjectsMock.mockRejectedValue(new Error('local lookup failed'));

    const context = await getMultiProjectContext();
    expect(context).toEqual({ promptPrefix: '', dynamicChatMcpUrl: null });
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
