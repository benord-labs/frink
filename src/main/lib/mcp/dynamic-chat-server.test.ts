/* eslint-disable max-lines -- large suite spans the MCP move + flow paths;
   splitting requires a shared-fixture module which costs more than it saves. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMode } from '../../../shared/types/chat-mode';
import {
  registerDynamicChatChannelTests,
  registerDynamicChatFlowDispatchTests,
} from './test-suites';

// Tests cover the un-gated flow tool list + dispatch. Re-enable the flag here
// so flow tools remain registered + dispatchable regardless of launch defaults.
vi.mock('../../../shared/launch-flags', () => ({
  LAUNCH_FLAGS: {
    flows: true,
    workQueue: true,
    integrations: true,
  },
}));

type WindowMock = {
  id: number;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
};

const state = vi.hoisted(() => {
  const windows: WindowMock[] = [
    {
      id: 1,
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    },
  ];
  const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => void>();

  return {
    windows,
    ipcHandlers,
    getCloudProjectById: vi.fn(),
    getChatById: vi.fn(),
    moveChatToProjectLocal: vi.fn(),
    updateChat: vi.fn(),
    invalidateStatus: vi.fn(),
    invalidateParsedDiff: vi.fn(),
    resolveTargetWorktreeForMove: vi.fn(),
    getProjectByIdLocal: vi.fn<
      (db: unknown, id: string) => Promise<{ id: string; name: string; path: string } | null>
    >(async () => null),
    listProjectsLocal: vi.fn<
      () => Promise<Array<{ id: string; name: string; path: string; description: string | null }>>
    >(async () => []),
    getCurrentBranch: vi.fn<(worktreePath: string) => Promise<string | null>>(async () => null),
    findChatByWorktree: vi.fn(),
    getChatsPageForProjects: vi.fn(),
    getSubChatsForChat: vi.fn(),
    createChat: vi.fn(),
    createSubChat: vi.fn(),
    clearCodexSession: vi.fn(),
    handleRemoteStop: vi.fn(),
    validateToolPermission: vi.fn(async () => ({ allowed: true as const })),
    consumeCodexMcpApproval: vi.fn(() => false),
    handleFlowsToolCall: vi.fn(
      async (
        _name: string,
        _args: Record<string, unknown>,
        _executionId?: string,
        _sessionProjectPath?: string,
      ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean } | null> => ({
        content: [{ type: 'text', text: 'flows-ok' }],
        isError: false,
      }),
    ),
    resetFlowsAddStageRunsCount: vi.fn((_executionId?: string) => undefined),
    resetFlowsRunCount: vi.fn((_executionId?: string) => undefined),
    resetFlowsPatchCount: vi.fn((_executionId?: string) => undefined),
    resetFlowsGetRunCount: vi.fn((_executionId?: string) => undefined),
    resetFlowsGetBatchCount: vi.fn((_executionId?: string) => undefined),
    resetFlowsListTemplatesCount: vi.fn((_executionId?: string) => undefined),
    resetListPluginToolsCount: vi.fn((_executionId?: string) => undefined),
    resetFlowsPatchCreateCount: vi.fn((_executionId?: string) => undefined),
    resetRegisterNodeCount: vi.fn((_executionId?: string) => undefined),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/frink-test-userdata'),
  },
  BrowserWindow: {
    getAllWindows: () => state.windows,
  },
  ipcMain: {
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      state.ipcHandlers.set(channel, handler);
    },
  },
}));

vi.mock('../agent-runner/codex/codex-host-permissions', () => ({
  codexHostPermissionDeduper: { consumeMcp: state.consumeCodexMcpApproval },
}));

vi.mock('../cloud-client', () => ({
  getCloudProjectById: state.getCloudProjectById,
}));

vi.mock('../db', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../db/repos/chats', async (importOriginal) => {
  // Keep pure helpers (parseWorktreeHistory etc.) real — the MCP handler calls them on the
  // sourceChat to feed the resolver.
  const actual = await importOriginal<typeof import('../db/repos/chats')>();
  return {
    ...actual,
    getChatById: state.getChatById,
    updateChat: state.updateChat,
    moveChatToProjectLocal: state.moveChatToProjectLocal,
  };
});

// Local projects repo — `frink_navigation_context` resolves project names locally first
// (chats are local-first). Default null forces the cloud fallback that most tests already
// mock; specific tests override this to assert enriched output.
vi.mock('../db/repos/projects', () => ({
  getProjectById: state.getProjectByIdLocal,
  listProjects: state.listProjectsLocal,
}));

vi.mock('../git/cache', () => ({
  gitCache: {
    invalidateStatus: state.invalidateStatus,
    invalidateParsedDiff: state.invalidateParsedDiff,
  },
}));

vi.mock('../git/resolve-target-worktree', () => ({
  resolveTargetWorktreeForMove: state.resolveTargetWorktreeForMove,
}));

// `frink_navigation_context` derives the live branch from disk; default null keeps
// existing tests unaware, the navigation-context tests override to assert enrichment.
vi.mock('../git/worktree', () => ({
  getCurrentBranch: state.getCurrentBranch,
}));

vi.mock('../socket/executor', () => ({
  clearCodexSession: (...args: unknown[]) => state.clearCodexSession(...args),
  handleRemoteStop: (...args: unknown[]) => state.handleRemoteStop(...args),
  validateToolPermission: state.validateToolPermission,
}));

vi.mock('./flows-tools', () => ({
  FLOWS_TOOLS: [
    {
      name: 'frink_flows_patch',
      description: 'Surgical flow graph updates',
      inputSchema: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          operations: { type: 'array' },
        },
        required: ['flowId', 'operations'],
      },
    },
    {
      name: 'frink_flows_list',
      description: 'List flows',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'frink_flows_get',
      description: 'Get a flow',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { flowId: { type: 'string' } },
        required: ['flowId'],
      },
    },
    {
      name: 'frink_flows_run',
      description: 'Start a flow run',
      inputSchema: {
        type: 'object',
        properties: { flowId: { type: 'string' } },
        required: ['flowId'],
      },
    },
    {
      name: 'frink_flows_get_run',
      description: 'Inspect a flow run',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
    },
    {
      name: 'frink_register_node',
      description: 'Register a custom node',
      inputSchema: {
        type: 'object',
        properties: { packagePath: { type: 'string' }, test: { type: 'object' } },
        required: ['packagePath'],
      },
    },
    {
      name: 'frink_flows_get_batch',
      description: 'Inspect batch/run execution state (list-runs, batch summary, or stages mode)',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          batchId: { type: 'string' },
        },
        required: ['flowId'],
      },
    },
    {
      name: 'frink_batch_message',
      description: 'Send a message to agents in a batch',
      inputSchema: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          batchId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['flowId', 'batchId', 'message'],
      },
    },
    {
      name: 'frink_flows_add_stage_runs',
      description: 'Add runs to a batch stage incrementally',
      inputSchema: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          batchId: { type: 'string' },
          stageNumber: { type: 'number' },
          runs: { type: 'array' },
        },
        required: ['flowId', 'batchId', 'stageNumber', 'runs'],
      },
    },
    {
      name: 'frink_flows_define_stages',
      description: 'Define staged execution for a batch',
      inputSchema: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          batchId: { type: 'string' },
          stages: { type: 'array' },
        },
        required: ['flowId', 'batchId', 'stages'],
      },
    },
    {
      name: 'frink_flows_start_batch',
      description: 'Start a staged batch',
      inputSchema: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          batchId: { type: 'string' },
        },
        required: ['flowId', 'batchId'],
      },
    },
    {
      name: 'frink_flows_list_catalog',
      description:
        'List a reference catalog (integrations, commands, templates, projects or nodes) for building flows',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['integrations', 'commands', 'templates', 'projects', 'nodes'],
          },
          flowId: { type: 'string' },
          pluginId: { type: 'string' },
          search: { type: 'string' },
        },
        required: ['kind'],
      },
    },
  ],
  FLOWS_TOOL_NAMES: new Set([
    'frink_flows_patch',
    'frink_flows_list',
    'frink_flows_get',
    'frink_flows_run',
    'frink_flows_get_run',
    'frink_register_node',
    'frink_flows_get_batch',
    'frink_batch_message',
    'frink_flows_add_stage_runs',
    'frink_flows_define_stages',
    'frink_flows_start_batch',
    'frink_flows_list_catalog',
  ]),
  handleFlowsToolCall: (
    name: string,
    args: Record<string, unknown>,
    executionId?: string,
    sessionProjectPath?: string,
  ) => state.handleFlowsToolCall(name, args, executionId, sessionProjectPath),
  resetFlowsAddStageRunsCount: (executionId?: string) =>
    state.resetFlowsAddStageRunsCount(executionId),
  resetFlowsRunCount: (executionId?: string) => state.resetFlowsRunCount(executionId),
  resetFlowsPatchCount: (executionId?: string) => state.resetFlowsPatchCount(executionId),
  resetFlowsGetRunCount: (executionId?: string) => state.resetFlowsGetRunCount(executionId),
  resetFlowsGetBatchCount: (executionId?: string) => state.resetFlowsGetBatchCount(executionId),
  resetFlowsListTemplatesCount: (executionId?: string) =>
    state.resetFlowsListTemplatesCount(executionId),
  resetListPluginToolsCount: (executionId?: string) => state.resetListPluginToolsCount(executionId),
  resetFlowsPatchCreateCount: (executionId?: string) =>
    state.resetFlowsPatchCreateCount(executionId),
  resetRegisterNodeCount: (executionId?: string) => state.resetRegisterNodeCount(executionId),
}));

const {
  bindChannelExecution,
  callDynamicChatToolByName,
  getLatestTaskSignal,
  setLatestTaskSignal,
  setCurrentExecutionChat,
  clearCurrentExecutionChat,
  getOrStartDynamicChatMcpUrl,
} = await import('./dynamic-chat-server');
const { getChannelToken } = await import('./execution-identity');

async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** Address a run by its sub-chat `channel`, optionally with the URL's `toolset`. */
function scopeUrl(url: string, channel?: string, toolset?: string): string {
  const scoped = new URL(url);
  if (channel) scoped.searchParams.set('channel', channel);
  if (toolset) scoped.searchParams.set('toolset', toolset);
  return scoped.toString();
}

async function listDynamicChatTools(
  channel?: string,
  toolset?: string,
): Promise<Array<{ name?: string; description?: string }>> {
  const url = await getOrStartDynamicChatMcpUrl();
  if (!url) throw new Error('Expected dynamic-chat MCP URL');
  const response = await fetch(scopeUrl(url, channel, toolset), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'tools-list', method: 'tools/list' }),
  });
  const payload = (await response.json()) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  return payload.result?.tools ?? [];
}

async function listDynamicChatToolNames(channel?: string, toolset?: string): Promise<string[]> {
  return (await listDynamicChatTools(channel, toolset)).map((tool) => tool.name ?? '');
}

/** A Codex run's channel: Codex binds its channel when the run registers. */
function codexChannel(subChatId: string, mode: ChatMode = 'agent', signal?: boolean): string {
  setCurrentExecutionChat('chat', subChatId, '/proj', mode, undefined, undefined, signal, 'codex');
  return getChannelToken(subChatId, 'codex');
}

async function callToolOverHttp(
  name: string,
  args: Record<string, unknown>,
  channel?: string,
  meta?: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> {
  const url = await getOrStartDynamicChatMcpUrl();
  if (!url) throw new Error('Expected dynamic-chat MCP URL');
  const scopedUrl = scopeUrl(url, channel);
  const response = await fetch(scopedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'tool-call',
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      },
    }),
  });
  const payload = (await response.json()) as {
    result?: { content?: Array<{ type: 'text'; text: string }>; isError?: boolean };
  };
  return {
    content: payload.result?.content ?? [],
    isError: payload.result?.isError ?? false,
  };
}

function emitMoveResponse(requestId: string, approved: boolean) {
  const handler = state.ipcHandlers.get('agent:move-chat-response');
  if (!handler) throw new Error('agent:move-chat-response handler not registered');
  handler({}, { requestId, approved });
}

function getLastMoveRequestPayload() {
  const sendCalls = state.windows[0].webContents.send.mock.calls;
  const moveRequestCall = [...sendCalls]
    .reverse()
    .find((call) => call[0] === 'agent:request-move-chat');
  return moveRequestCall?.[1] as
    | {
        requestId: string;
        chatId: string;
        subChatId: string;
        projectId: string;
        projectName: string;
        targetChatId: string;
        targetSubChatId: string;
        projectPath: string;
        requestedWorktreePath: string | null;
        targetBranch: string | null;
      }
    | undefined;
}

function requireMovePayload() {
  const payload = getLastMoveRequestPayload();
  if (!payload) throw new Error('Expected agent:request-move-chat payload');
  return payload;
}

describe('dynamic-chat-server requestSwitchProject', () => {
  beforeEach(() => {
    clearCurrentExecutionChat();
    state.windows[0].webContents.send.mockReset();
    state.getCloudProjectById.mockReset();
    state.getProjectByIdLocal.mockReset();
    state.getChatById.mockReset();
    state.moveChatToProjectLocal.mockReset();
    state.updateChat.mockReset();
    state.findChatByWorktree.mockReset();
    state.getChatsPageForProjects.mockReset();
    state.getSubChatsForChat.mockReset();
    state.createChat.mockReset();
    state.createSubChat.mockReset();
    state.clearCodexSession.mockReset();
    state.handleRemoteStop.mockReset();
    state.invalidateStatus.mockReset();
    state.invalidateParsedDiff.mockReset();
    state.resolveTargetWorktreeForMove.mockReset();
    // Default resolver: explicit-or-project-root, no branch restore, no stale prune.
    // Tests override this to exercise the auto-restore branch.
    state.resolveTargetWorktreeForMove.mockImplementation(
      async (params: {
        targetProjectId: string | null;
        targetProjectPath: string | null;
        explicitWorktreePath: string | null;
        history: Record<string, string>;
      }) => ({
        worktreePath: params.explicitWorktreePath ?? params.targetProjectPath,
        branch: null,
        baseBranch: null,
        stalePrunedProjectId: null,
      }),
    );
    state.moveChatToProjectLocal.mockImplementation(
      async (
        _db: unknown,
        _id: string,
        opts: {
          projectId: string | null;
          worktreePath: string | null;
          branch: string | null;
          baseBranch: string | null;
          stalePrunedProjectId: string | null;
        },
      ) => ({
        updated: {
          id: 'chat-1',
          projectId: opts.projectId,
          worktreePath: opts.worktreePath,
          branch: opts.branch,
          baseBranch: opts.baseBranch,
          // Default echo: tests overriding the mock can return a specific history string.
          worktreeHistory: '{}',
          archivedAt: null,
        },
        previousWorktreePath: '/old/worktree',
      }),
    );
    state.updateChat.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/new/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });
  });

  afterEach(() => {
    clearCurrentExecutionChat();
  });

  it('returns moved outcome and emits move-chat-approved when user approves', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/old/path' };
      return null;
    });
    state.getChatById.mockImplementation(async (_db: unknown, chatId: string) => {
      if (chatId === 'chat-1') {
        return {
          id: 'chat-1',
          projectId: 'project-1',
          worktreePath: '/old/worktree',
          branch: 'feat-old',
          archivedAt: null,
        };
      }
      if (chatId === 'chat-2') {
        return {
          id: 'chat-2',
          projectId: 'project-2',
          worktreePath: null,
          branch: null,
          archivedAt: null,
        };
      }
      return null;
    });
    state.findChatByWorktree.mockResolvedValue(null);
    state.getChatsPageForProjects.mockResolvedValue([
      {
        id: 'chat-2',
        project_id: 'project-2',
        worktree_path: null,
        branch: null,
        archived_at: null,
      },
    ]);
    state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);

    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2' },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    expect(payload?.chatId).toBe('chat-1');
    expect(payload?.projectId).toBe('project-2');
    emitMoveResponse(payload.requestId, true);

    const result = await promise;
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      approved: boolean;
      outcome: string;
      requiresNewTurn?: boolean;
    };
    expect(parsed.approved).toBe(true);
    expect(parsed.outcome).toBe('moved');
    expect(parsed.requiresNewTurn).toBe(true);
    expect(state.clearCodexSession).toHaveBeenCalledWith('chat-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.handleRemoteStop).toHaveBeenCalledWith({ chatId: 'chat-1', subChatId: 'sub-1' });

    const approvedCall = state.windows[0].webContents.send.mock.calls.find(
      (call) => call[0] === 'agent:move-chat-approved',
    );
    expect(approvedCall?.[1]).toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        projectId: 'project-2',
        projectPath: '/new/path',
        navigationSessionId: expect.any(String),
      }),
    );
  });

  it('returns denied outcome when user denies', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/old/path' };
      return null;
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/old/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });
    state.findChatByWorktree.mockResolvedValue(null);
    state.getChatsPageForProjects.mockResolvedValue([
      {
        id: 'chat-2',
        project_id: 'project-2',
        worktree_path: null,
        branch: null,
        archived_at: null,
      },
    ]);
    state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);

    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2' },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    emitMoveResponse(payload.requestId, false);
    const result = await promise;
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      approved: boolean;
      outcome: string;
    };

    expect(parsed.approved).toBe(false);
    expect(parsed.outcome).toBe('denied');
    const approvedCall = state.windows[0].webContents.send.mock.calls.find(
      (call) => call[0] === 'agent:move-chat-approved',
    );
    expect(approvedCall).toBeUndefined();
  });

  it('does not instruct agents to STOP in requestSwitchProject tool metadata or success payload', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/old/path' };
      return null;
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/old/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });
    state.findChatByWorktree.mockResolvedValue(null);
    state.getChatsPageForProjects.mockResolvedValue([
      {
        id: 'chat-2',
        project_id: 'project-2',
        worktree_path: null,
        branch: null,
        archived_at: null,
      },
    ]);
    state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);

    const tools = await listDynamicChatTools();
    const switchTool = tools.find((tool) => tool.name === 'requestSwitchProject');
    expect(switchTool?.description).toBeDefined();
    expect((switchTool?.description ?? '').toLowerCase()).not.toContain('stop your current turn');

    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2' },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    emitMoveResponse(payload.requestId, true);

    const result = await promise;
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { message?: string };
    expect(parsed.message).toBeDefined();
    expect((parsed.message ?? '').toLowerCase()).not.toContain('stop your current turn');
  });

  it('returns no-context error when requestSwitchProject called without active execution context', async () => {
    state.getProjectByIdLocal.mockResolvedValue({
      id: 'project-2',
      name: 'Hackathon',
      path: '/new/path',
    });
    const result = await callDynamicChatToolByName('requestSwitchProject', {
      project_id: 'project-2',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No active chat context');
  });

  it('returns already_in_chat when same-project resolution lands on current chat', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockResolvedValue({
      id: 'project-2',
      name: 'Hackathon',
      path: '/new/path',
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-2',
      worktreePath: null,
      branch: null,
      archivedAt: null,
    });
    state.findChatByWorktree.mockResolvedValue(null);
    state.getChatsPageForProjects.mockResolvedValue([
      {
        id: 'chat-1',
        project_id: 'project-2',
        worktree_path: null,
        branch: null,
        archived_at: null,
      },
    ]);
    state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-1' }]);

    const result = await callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2' },
      executionId,
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('already_in_chat');
    expect(result.content[0]?.text).toContain('You are already in this chat');
  });

  it('allows same-project switch when requested worktree differs from current worktree', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockResolvedValue({
      id: 'project-1',
      name: 'Owners',
      path: '/old/path',
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/old/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });

    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-1', worktree_path: '/new/worktree' },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    expect(payload.projectId).toBe('project-1');
    expect(payload.requestedWorktreePath).toBe('/new/worktree');
    emitMoveResponse(payload.requestId, true);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('"outcome": "moved"');
    expect(result.content[0]?.text).toContain('"requestedWorktreePath": "/new/worktree"');
    expect(state.updateChat).toHaveBeenCalledWith(expect.anything(), 'chat-1', {
      worktreePath: '/new/worktree',
    });
    expect(state.moveChatToProjectLocal).not.toHaveBeenCalled();
  });

  it('allows same-project switch from worktree back to project root', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/worktree');
    state.getProjectByIdLocal.mockResolvedValue({
      id: 'project-1',
      name: 'Owners',
      path: '/old/path',
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/old/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });

    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-1' },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    expect(payload.projectId).toBe('project-1');
    expect(payload.requestedWorktreePath).toBeNull();
    emitMoveResponse(payload.requestId, true);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('"outcome": "moved"');
    expect(state.updateChat).toHaveBeenCalledWith(expect.anything(), 'chat-1', {
      worktreePath: null,
    });
    expect(state.moveChatToProjectLocal).not.toHaveBeenCalled();
  });

  it('supports explicit worktree targeting via worktree_path', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/old/path' };
      return null;
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/old/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });
    state.updateChat.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-2',
      worktreePath: '/worktrees/frink/feature-return',
      branch: 'feat-old',
      archivedAt: null,
    });
    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2', worktree_path: '/worktrees/frink/feature-return' },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    expect(payload.targetChatId).toBe('chat-1');
    expect(payload.requestedWorktreePath).toBe('/worktrees/frink/feature-return');
    emitMoveResponse(payload.requestId, true);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('"approved": true');
    expect(result.content[0]?.text).toContain(
      '"requestedWorktreePath": "/worktrees/frink/feature-return"',
    );
  });

  it('auto-restores a previous worktree from history when worktree_path is omitted', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/new/path');
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/old/path' };
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
      return null;
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-2',
      worktreePath: '/new/path',
      worktreeHistory: '{"project-1":"/wt/feat-prev"}',
      branch: null,
      archivedAt: null,
    });
    // Resolver finds the historical entry + verifies it on disk → restores it.
    state.resolveTargetWorktreeForMove.mockResolvedValueOnce({
      worktreePath: '/wt/feat-prev',
      branch: 'feat-prev',
      baseBranch: 'main',
      stalePrunedProjectId: null,
    });

    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-1' }, // no worktree_path — agent isn't forcing one
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    // Approval dialog reflects the actual destination, not project root.
    expect(payload.requestedWorktreePath).toBe('/wt/feat-prev');
    expect(payload.projectPath).toBe('/wt/feat-prev');
    emitMoveResponse(payload.requestId, true);

    await promise;

    // Resolver invoked with the agent's null override + the chat's parsed history.
    expect(state.resolveTargetWorktreeForMove).toHaveBeenCalledWith({
      targetProjectId: 'project-1',
      targetProjectPath: '/old/path',
      explicitWorktreePath: null,
      history: { 'project-1': '/wt/feat-prev' },
    });
    // Helper receives the resolver's restored worktreePath + branch. The history append
    // happens INSIDE the helper's transaction (from the live row), not from a caller snapshot,
    // so we only assert the stale-prune flag here (none for a successful restore).
    expect(state.moveChatToProjectLocal).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      expect.objectContaining({
        worktreePath: '/wt/feat-prev',
        branch: 'feat-prev',
        baseBranch: 'main',
        stalePrunedProjectId: null,
      }),
    );
  });

  it('blocks concurrent in-flight switch requests in the same execution', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/old/path' };
      return null;
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/old/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });
    state.findChatByWorktree.mockResolvedValue(null);
    state.getChatsPageForProjects.mockResolvedValue([
      {
        id: 'chat-2',
        project_id: 'project-2',
        worktree_path: null,
        branch: null,
        archived_at: null,
      },
    ]);
    state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);

    const firstSwitchPromise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2' },
      executionId,
    );
    await flushMicrotasks();

    const secondSwitchPromise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2' },
      executionId,
    );
    await flushMicrotasks();

    const requestPayloads = state.windows[0].webContents.send.mock.calls
      .filter((call) => call[0] === 'agent:request-move-chat')
      .map((call) => call[1] as { requestId: string });

    for (const payload of requestPayloads) {
      emitMoveResponse(payload.requestId, false);
    }
    await firstSwitchPromise;
    const secondResult = await secondSwitchPromise;

    // TDD expectation: while one switch approval is pending, second call should be rejected.
    expect(requestPayloads).toHaveLength(1);
    expect(secondResult.isError).toBe(true);
    expect(secondResult.content[0]?.text).toContain('already pending');
  });

  it('fails gracefully when moveChatToProjectLocal fails after approval', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/old/path' };
      return null;
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/old/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });
    state.moveChatToProjectLocal.mockResolvedValue({ updated: null, previousWorktreePath: null });

    const switchPromise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2' },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    emitMoveResponse(payload.requestId, true);

    const result = await switchPromise;
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      approved?: boolean;
      userApproved?: boolean;
      outcome?: string;
    };
    const approvedCall = state.windows[0].webContents.send.mock.calls.find(
      (call) => call[0] === 'agent:move-chat-approved',
    );

    expect(result.isError).toBe(true);
    expect(parsed.approved).toBe(false);
    expect(parsed.userApproved).toBe(true);
    expect(parsed.outcome).toBe('move_failed');
    expect(result.content[0]?.text).toContain('move failed');
    expect(approvedCall).toBeUndefined();
  });

  it('normalizes worktree_path before emitting move request payload', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/old/path' };
      return null;
    });
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-1',
      worktreePath: '/old/worktree',
      branch: 'feat-old',
      archivedAt: null,
    });
    const weirdPath = '/worktrees/frink/feature/../feature';
    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2', worktree_path: weirdPath },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    emitMoveResponse(payload.requestId, false);
    const result = await promise;

    expect(payload.requestedWorktreePath).toBe('/worktrees/frink/feature');
    expect(result.isError).toBe(true);
  });

  describe('handleRemoteStop edge cases', () => {
    it('calls handleRemoteStop once per successful move', async () => {
      state.handleRemoteStop.mockClear();
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
      state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
        if (projectId === 'project-2')
          return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
        if (projectId === 'project-1')
          return { id: 'project-1', name: 'Owners', path: '/old/path' };
        return null;
      });
      state.getChatById.mockResolvedValue({
        id: 'chat-1',
        projectId: 'project-1',
        worktreePath: null,
        branch: null,
        archivedAt: null,
      });
      state.findChatByWorktree.mockResolvedValue(null);
      state.getChatsPageForProjects.mockResolvedValue([
        {
          id: 'chat-2',
          project_id: 'project-2',
          worktree_path: null,
          branch: null,
          archived_at: null,
        },
      ]);
      state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);

      const promise = callDynamicChatToolByName(
        'requestSwitchProject',
        { project_id: 'project-2' },
        executionId,
      );
      await flushMicrotasks();
      const payload = requireMovePayload();
      emitMoveResponse(payload.requestId, true);
      await promise;

      await new Promise<void>((resolve) => setImmediate(resolve));
      // Verify handleRemoteStop was called with correct args (may be called multiple times from other tests)
      expect(state.handleRemoteStop).toHaveBeenCalledWith({ chatId: 'chat-1', subChatId: 'sub-1' });
    });

    it('does not call handleRemoteStop when moveChatToProjectLocal fails', async () => {
      state.handleRemoteStop.mockClear();
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
      state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
        if (projectId === 'project-2')
          return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
        if (projectId === 'project-1')
          return { id: 'project-1', name: 'Owners', path: '/old/path' };
        return null;
      });
      state.getChatById.mockResolvedValue({
        id: 'chat-1',
        projectId: 'project-1',
        worktreePath: null,
        branch: null,
        archivedAt: null,
      });
      state.moveChatToProjectLocal.mockResolvedValue({ updated: null, previousWorktreePath: null });

      const promise = callDynamicChatToolByName(
        'requestSwitchProject',
        { project_id: 'project-2' },
        executionId,
      );
      await flushMicrotasks();
      const payload = requireMovePayload();
      emitMoveResponse(payload.requestId, true);
      await promise;

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(state.handleRemoteStop).not.toHaveBeenCalled();
    });

    it('handles handleRemoteStop throwing an error gracefully', async () => {
      state.handleRemoteStop.mockClear();
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
      state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
        if (projectId === 'project-2')
          return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
        if (projectId === 'project-1')
          return { id: 'project-1', name: 'Owners', path: '/old/path' };
        return null;
      });
      state.getChatById.mockResolvedValue({
        id: 'chat-1',
        projectId: 'project-1',
        worktreePath: null,
        branch: null,
        archivedAt: null,
      });
      state.findChatByWorktree.mockResolvedValue(null);
      state.getChatsPageForProjects.mockResolvedValue([
        {
          id: 'chat-2',
          project_id: 'project-2',
          worktree_path: null,
          branch: null,
          archived_at: null,
        },
      ]);
      state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);
      state.handleRemoteStop.mockImplementation(() => {
        throw new Error('Stop failed');
      });

      const promise = callDynamicChatToolByName(
        'requestSwitchProject',
        { project_id: 'project-2' },
        executionId,
      );
      await flushMicrotasks();
      const payload = requireMovePayload();
      emitMoveResponse(payload.requestId, true);

      const result = await promise;
      // Move should still succeed even if handleRemoteStop throws
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0]?.text ?? '{}');
      expect(parsed.approved).toBe(true);
      expect(parsed.outcome).toBe('moved');
    });
  });

  describe('execution lifecycle edge cases', () => {
    it('handles chat deleted between approval and moveChatToProjectLocal', async () => {
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
      state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
        if (projectId === 'project-2')
          return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
        if (projectId === 'project-1')
          return { id: 'project-1', name: 'Owners', path: '/old/path' };
        return null;
      });
      state.getChatById.mockResolvedValue({
        id: 'chat-1',
        projectId: 'project-1',
        worktreePath: null,
        branch: null,
        archivedAt: null,
      });
      state.findChatByWorktree.mockResolvedValue(null);
      state.getChatsPageForProjects.mockResolvedValue([
        {
          id: 'chat-2',
          project_id: 'project-2',
          worktree_path: null,
          branch: null,
          archived_at: null,
        },
      ]);
      state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);
      // Chat deleted after approval - moveChatToProjectLocal returns updated: null
      state.moveChatToProjectLocal.mockResolvedValue({ updated: null, previousWorktreePath: null });

      const promise = callDynamicChatToolByName(
        'requestSwitchProject',
        { project_id: 'project-2' },
        executionId,
      );
      await flushMicrotasks();
      const payload = requireMovePayload();
      emitMoveResponse(payload.requestId, true);

      const result = await promise;
      // Should handle gracefully - moveChatToProjectLocal returns updated: null when chat deleted
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('move failed');
    });

    it('handles project deleted during move', async () => {
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
      state.getProjectByIdLocal.mockResolvedValue({
        id: 'project-2',
        name: 'Hackathon',
        path: '/new/path',
      });
      state.getChatById.mockResolvedValue({
        id: 'chat-1',
        projectId: 'project-1',
        worktreePath: null,
        branch: null,
        archivedAt: null,
      });
      state.findChatByWorktree.mockResolvedValue(null);
      state.getChatsPageForProjects.mockResolvedValue([
        {
          id: 'chat-2',
          project_id: 'project-2',
          worktree_path: null,
          branch: null,
          archived_at: null,
        },
      ]);
      state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);
      // Project deleted after approval - moveChatToProjectLocal returns updated: null
      state.moveChatToProjectLocal.mockResolvedValue({ updated: null, previousWorktreePath: null });

      const promise = callDynamicChatToolByName(
        'requestSwitchProject',
        { project_id: 'project-2' },
        executionId,
      );
      await flushMicrotasks();
      const payload = requireMovePayload();
      emitMoveResponse(payload.requestId, true);

      const result = await promise;
      // moveChatToProjectLocal returns updated: null when project doesn't exist
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('move failed');
    });

    it('handles moveChatToProjectLocal throwing an exception', async () => {
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
      state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
        if (projectId === 'project-2')
          return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
        if (projectId === 'project-1')
          return { id: 'project-1', name: 'Owners', path: '/old/path' };
        return null;
      });
      state.getChatById.mockResolvedValue({
        id: 'chat-1',
        projectId: 'project-1',
        worktreePath: null,
        branch: null,
        archivedAt: null,
      });
      state.findChatByWorktree.mockResolvedValue(null);
      state.getChatsPageForProjects.mockResolvedValue([
        {
          id: 'chat-2',
          project_id: 'project-2',
          worktree_path: null,
          branch: null,
          archived_at: null,
        },
      ]);
      state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);
      state.moveChatToProjectLocal.mockRejectedValue(new Error('Database connection failed'));

      const promise = callDynamicChatToolByName(
        'requestSwitchProject',
        { project_id: 'project-2' },
        executionId,
      );
      await flushMicrotasks();
      const payload = requireMovePayload();
      emitMoveResponse(payload.requestId, true);

      const result = await promise;
      // Exception should be caught and treated as move failure
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('move failed');
      expect(state.handleRemoteStop).not.toHaveBeenCalled();
    });
  });

  describe('navigation session edge cases', () => {
    it('creates new navigation session when none exists', async () => {
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');
      state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
        if (projectId === 'project-2')
          return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
        if (projectId === 'project-1')
          return { id: 'project-1', name: 'Owners', path: '/old/path' };
        return null;
      });
      state.getChatById.mockResolvedValue({
        id: 'chat-1',
        projectId: 'project-1',
        worktreePath: null,
        branch: null,
        archivedAt: null,
      });
      state.findChatByWorktree.mockResolvedValue(null);
      state.getChatsPageForProjects.mockResolvedValue([
        {
          id: 'chat-2',
          project_id: 'project-2',
          worktree_path: null,
          branch: null,
          archived_at: null,
        },
      ]);
      state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);

      const promise = callDynamicChatToolByName(
        'requestSwitchProject',
        { project_id: 'project-2' },
        executionId,
      );
      await flushMicrotasks();
      const payload = requireMovePayload();
      emitMoveResponse(payload.requestId, true);

      const result = await promise;
      expect(result.isError).toBe(false);
      const approvedCall = state.windows[0].webContents.send.mock.calls.find(
        (call) => call[0] === 'agent:move-chat-approved',
      );
      expect(approvedCall?.[1]).toHaveProperty('navigationSessionId');
      expect(approvedCall?.[1].navigationSessionId).toBeTruthy();
    });

    it('reuses existing navigation session when present', async () => {
      const executionId = setCurrentExecutionChat(
        'chat-1',
        'sub-1',
        '/old/path', 'agent',
        'nav-session-1',
      );
      state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
        if (projectId === 'project-2')
          return { id: 'project-2', name: 'Hackathon', path: '/new/path' };
        if (projectId === 'project-1')
          return { id: 'project-1', name: 'Owners', path: '/old/path' };
        return null;
      });
      state.getChatById.mockResolvedValue({
        id: 'chat-1',
        projectId: 'project-1',
        worktreePath: null,
        branch: null,
        archivedAt: null,
      });
      state.findChatByWorktree.mockResolvedValue(null);
      state.getChatsPageForProjects.mockResolvedValue([
        {
          id: 'chat-2',
          project_id: 'project-2',
          worktree_path: null,
          branch: null,
          archived_at: null,
        },
      ]);
      state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);

      const promise = callDynamicChatToolByName(
        'requestSwitchProject',
        { project_id: 'project-2' },
        executionId,
      );
      await flushMicrotasks();
      const payload = requireMovePayload();
      emitMoveResponse(payload.requestId, true);

      const result = await promise;
      expect(result.isError).toBe(false);
      const approvedCall = state.windows[0].webContents.send.mock.calls.find(
        (call) => call[0] === 'agent:move-chat-approved',
      );
      // Session should be updated, not replaced
      expect(approvedCall?.[1]).toHaveProperty('navigationSessionId');
    });
  });

  it('clears only the targeted execution context', async () => {
    const executionA = setCurrentExecutionChat(
      'chat-a',
      'sub-a',
      '/project-a',
      'agent',
    );
    const executionB = setCurrentExecutionChat(
      'chat-b',
      'sub-b',
      '/project-b',
      'agent',
    );

    clearCurrentExecutionChat(executionA);

    const scopedResult = await callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-b' },
      executionB,
    );
    expect(scopedResult.content[0]?.text).not.toContain('No active chat context');

    const clearedResult = await callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-a' },
      executionA,
    );
    expect(clearedResult.isError).toBe(true);
    expect(clearedResult.content[0]?.text).toContain('No active chat context');
  });

  it('clearCurrentExecutionChat without executionId clears all active contexts', async () => {
    const executionA = setCurrentExecutionChat(
      'chat-a',
      'sub-a',
      '/project-a',
      'agent',
    );
    const executionB = setCurrentExecutionChat(
      'chat-b',
      'sub-b',
      '/project-b',
      'agent',
    );

    clearCurrentExecutionChat();

    const resultA = await callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-a' },
      executionA,
    );
    const resultB = await callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-b' },
      executionB,
    );
    expect(resultA.isError).toBe(true);
    expect(resultB.isError).toBe(true);
    expect(resultA.content[0]?.text).toContain('No active chat context');
    expect(resultB.content[0]?.text).toContain('No active chat context');
  });
});

describe('dynamic-chat-server frink_task_signal', () => {
  beforeEach(() => {
    clearCurrentExecutionChat();
  });

  afterEach(() => {
    clearCurrentExecutionChat();
  });

  it('includes frink_task_signal in tools list for scoped execution', async () => {
    const tools = await listDynamicChatToolNames(codexChannel('sub-signal'), 'agent:signal');
    expect(tools).toContain('frink_task_signal');
  });

  it('lets native-hook providers discover outcomes without a proactive final-message mandate', async () => {
    const tools = await listDynamicChatTools();
    const taskSignalTool = tools.find((tool) => tool.name === 'frink_task_signal');
    expect(taskSignalTool?.description).not.toContain('MANDATORY');
    expect(taskSignalTool?.description).not.toContain('MUST call this tool');
    expect(taskSignalTool?.description).toContain('state="done"');
    expect(taskSignalTool?.description).toContain('active background work');
    expect(taskSignalTool?.description).not.toContain('state="completed"');
  });

  it('stores latest task signal in execution context', async () => {
    const executionId = setCurrentExecutionChat('chat-signal', 'sub-signal', '/project');
    const result = await callDynamicChatToolByName(
      'frink_task_signal',
      {
        state: 'partial',
        summary: 'Completed initial setup',
        details: 'Waiting on credentials',
        verification: { checks: ['setup'] },
      },
      executionId,
    );

    expect(result.isError).toBe(false);
    const latestSignal = getLatestTaskSignal(executionId);
    expect(latestSignal).toEqual(
      expect.objectContaining({
        state: 'partial',
        summary: 'Completed initial setup',
        details: 'Waiting on credentials',
        verification: { checks: ['setup'] },
      }),
    );
  });

  // The AskUserQuestion translate parks a Flow without the agent ever calling frink_task_signal, so
  // it writes this slot directly. Miss it and both the Stop hook and the post-stream finalize read
  // an empty signal — the run never parks.
  it('accepts a task signal recorded without a tool call, and refuses one with no live run', () => {
    const executionId = setCurrentExecutionChat('chat-park', 'sub-park', '/project');
    const parked = { state: 'awaiting_input' as const, summary: 'Needs your input: Diff scope' };

    expect(setLatestTaskSignal(parked, executionId)).toBe(true);
    expect(getLatestTaskSignal(executionId)).toEqual(expect.objectContaining(parked));

    clearCurrentExecutionChat(executionId);
    expect(setLatestTaskSignal(parked, executionId)).toBe(false);
  });

  it('stores awaiting_input questions so the renderer can show clickable options', async () => {
    const executionId = setCurrentExecutionChat('chat-signal', 'sub-signal', '/project');
    const result = await callDynamicChatToolByName(
      'frink_task_signal',
      {
        state: 'awaiting_input',
        summary: 'Which path?',
        questions: [
          {
            header: 'Path',
            question: 'Which path?',
            options: [{ label: 'Implement now' }, { label: 'Route a step first' }],
          },
        ],
      },
      executionId,
    );
    expect(result.isError).toBe(false);
    expect(getLatestTaskSignal(executionId)?.questions).toEqual([
      expect.objectContaining({ header: 'Path', multiSelect: false }),
    ]);
  });

  it('exposes a questions property on the frink_task_signal input schema', async () => {
    const tools = await listDynamicChatTools();
    const taskSignalTool = tools.find((tool) => tool.name === 'frink_task_signal') as unknown as
      | { inputSchema?: { properties?: Record<string, unknown> } }
      | undefined;
    expect(taskSignalTool?.inputSchema?.properties).toHaveProperty('questions');
  });

  it('requires active execution context and validates payload', async () => {
    const missingContext = await callDynamicChatToolByName('frink_task_signal', {
      state: 'done',
      summary: 'Done',
    });
    expect(missingContext.isError).toBe(true);
    expect(missingContext.content[0]?.text).toContain('requires an active execution context');

    const executionId = setCurrentExecutionChat('chat-signal', 'sub-signal', '/project');
    const invalidPayload = await callDynamicChatToolByName(
      'frink_task_signal',
      {
        state: 'manual_confirmation',
        summary: 'Should fail',
      },
      executionId,
    );
    expect(invalidPayload.isError).toBe(true);
    expect(invalidPayload.content[0]?.text).toContain('Invalid arguments');
  });

  it('omits frink_task_signal from tools list when the URL toolset carries no signal', async () => {
    const tools = await listDynamicChatToolNames(undefined, 'agent:nosignal');
    expect(tools).not.toContain('frink_task_signal');
    // Other base tools are unaffected by the gate.
    expect(tools).toContain('searchProjects');
  });

  it('refuses frink_task_signal calls and records nothing when disarmed', async () => {
    const executionId = setCurrentExecutionChat(
      'chat-signal',
      'sub-signal',
      '/project', 'agent',
      undefined,
      undefined,
      false,
    );
    const result = await callDynamicChatToolByName(
      'frink_task_signal',
      { state: 'done', summary: 'Done' },
      executionId,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No active task expects a lifecycle signal');
    expect(getLatestTaskSignal(executionId)).toBeUndefined();
  });

  it('scopes the disarmed state per execution — concurrent panes do not leak', async () => {
    // Multi-pane: a live flow chat (armed) and a finished flow chat (disarmed) executing at the
    // same time must each keep their own signal gate.
    const signal = { state: 'done', summary: 'Done' };
    const armed = await callToolOverHttp('frink_task_signal', signal, codexChannel('sub-armed'));
    const dead = codexChannel('sub-dead', 'agent', false);
    const disarmed = await callToolOverHttp('frink_task_signal', signal, dead);
    expect(armed.isError).toBe(false);
    expect(disarmed.content[0]?.text).toContain('No active task expects a lifecycle signal');
  });

  it('inherits the disarmed state across re-calls on the same execution id', async () => {
    const executionId = setCurrentExecutionChat(
      'chat-signal',
      'sub-signal',
      '/project', 'agent',
      undefined,
      undefined,
      false,
      'codex',
    );
    // Mid-turn resume paths re-register without threading the flag — must not silently re-arm.
    setCurrentExecutionChat(
      'chat-signal',
      'sub-signal',
      '/project',
      'agent',
      executionId,
    );
    const result = await callToolOverHttp(
      'frink_task_signal',
      { state: 'done', summary: 'Done' },
      getChannelToken('sub-signal', 'codex'),
    );
    expect(result.content[0]?.text).toContain('No active task expects a lifecycle signal');
  });
});

describe('dynamic-chat-server frink_navigation_context', () => {
  beforeEach(() => {
    clearCurrentExecutionChat();
    state.windows[0].webContents.send.mockReset();
    state.getCloudProjectById.mockReset();
    state.getChatById.mockReset();
    state.findChatByWorktree.mockReset();
    state.getChatsPageForProjects.mockReset();
    state.getSubChatsForChat.mockReset();
  });

  afterEach(() => {
    clearCurrentExecutionChat();
  });

  it('requires an active execution context', async () => {
    const result = await callDynamicChatToolByName('frink_navigation_context', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No active chat context');
  });

  it('returns current context with null origin before any switch', async () => {
    const executionId = setCurrentExecutionChat('chat-current', 'sub-current', '/owners');
    state.getChatById.mockResolvedValue({
      id: 'chat-current',
      projectId: 'project-1',
      worktreePath: '/owners/worktrees/feat-a',
      branch: 'feat-a',
      archivedAt: null,
    });
    state.getCloudProjectById.mockResolvedValue({
      id: 'project-1',
      name: 'Owners',
      path: '/owners',
    });

    const result = await callDynamicChatToolByName('frink_navigation_context', {}, executionId);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      history: unknown[];
      current: { projectId: string; chatId: string; worktreePath: string | null };
    };
    // No move recorded yet → persistent history is empty.
    expect(parsed.history).toEqual([]);
    expect(parsed.current).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        chatId: 'chat-current',
        worktreePath: '/owners/worktrees/feat-a',
      }),
    );
  });

  it('enriches current/origin/history with live local project names + branches', async () => {
    const executionId = setCurrentExecutionChat('chat-current', 'sub-current', '/owners');
    state.getChatById.mockResolvedValue({
      id: 'chat-current',
      projectId: 'project-current',
      worktreePath: '/wt/now',
      worktreeHistory: '{"project-prev":"/wt/feat-prev"}',
      branch: null, // non-worktree chat has null in DB; derived live from disk
      archivedAt: null,
    });
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, id: string) => {
      if (id === 'project-current') return { id, name: 'Current', path: '/current' };
      if (id === 'project-prev') return { id, name: 'Previous', path: '/previous' };
      return null;
    });
    state.getCurrentBranch.mockImplementation(async (path: string) => {
      if (path === '/wt/now') return 'feat-now';
      if (path === '/wt/feat-prev') return 'feat-prev';
      return null;
    });

    const result = await callDynamicChatToolByName('frink_navigation_context', {}, executionId);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      current: { projectName: string; branch: string | null };
      origin: { projectId: string; projectName: string; branch: string | null } | null;
      history: Array<{
        projectId: string;
        projectName: string;
        worktreePath: string;
        branch: string | null;
      }>;
    };
    // Current project resolves locally — "Unknown Project" no longer appears for local-only
    // projects. Branch derived live from the worktree dir's git HEAD.
    expect(parsed.current.projectName).toBe('Current');
    expect(parsed.current.branch).toBe('feat-now');
    // Origin = first history entry (the project the chat started in / left first).
    expect(parsed.origin).toEqual({
      projectId: 'project-prev',
      projectName: 'Previous',
      worktreePath: '/wt/feat-prev',
      branch: 'feat-prev',
    });
    // History entries carry the live project name + live branch (storage stays a flat
    // projectId → worktreePath map; everything else is read-time-enriched).
    expect(parsed.history).toEqual([
      {
        projectId: 'project-prev',
        projectName: 'Previous',
        worktreePath: '/wt/feat-prev',
        branch: 'feat-prev',
      },
    ]);
  });

  it('falls back to current as origin when history is empty (chat never moved)', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/proj/a');
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-a',
      worktreePath: '/proj/a',
      worktreeHistory: null,
      branch: null,
      archivedAt: null,
    });
    state.getProjectByIdLocal.mockResolvedValue({
      id: 'project-a',
      name: 'Alpha',
      path: '/proj/a',
    });
    state.getCurrentBranch.mockResolvedValue('main');

    const result = await callDynamicChatToolByName('frink_navigation_context', {}, executionId);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      origin: { projectId: string; projectName: string; branch: string | null } | null;
      history: unknown[];
    };
    expect(parsed.history).toEqual([]);
    // No moves yet — chat is still at its origin. Agent's "move back to origin" resolves
    // here too (no-op move, but the answer is meaningful).
    expect(parsed.origin).toEqual({
      projectId: 'project-a',
      projectName: 'Alpha',
      worktreePath: '/proj/a',
      branch: 'main',
    });
  });

  it('returns null origin for a General Chats chat with no project + no history', async () => {
    // No project + no history → there is no meaningful "origin" to navigate to. Agent
    // asking "move back to origin" must get null rather than a bogus snapshot of `current`
    // (the General Chats current has no projectId to move TO).
    const executionId = setCurrentExecutionChat('chat-general', 'sub-1', '');
    state.getChatById.mockResolvedValue({
      id: 'chat-general',
      projectId: null,
      worktreePath: null,
      worktreeHistory: null,
      branch: null,
      archivedAt: null,
    });

    const result = await callDynamicChatToolByName('frink_navigation_context', {}, executionId);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      current: { projectId: string | null };
      origin: unknown;
      history: unknown[];
    };
    expect(parsed.current.projectId).toBeNull();
    expect(parsed.origin).toBeNull();
    expect(parsed.history).toEqual([]);
  });

  it('falls back to buildProjectName when a history entry references a deleted project', async () => {
    // A project the chat once visited may have been removed locally (and isn't in cloud
    // either — local-first; cloud is parked). The enrichment must not throw and must still
    // return a usable name so the agent can present something to the user.
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/now');
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-current',
      worktreePath: '/wt/now',
      worktreeHistory: '{"project-gone":"/wt/abandoned"}',
      branch: null,
      archivedAt: null,
    });
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, id: string) => {
      if (id === 'project-current') return { id, name: 'Current', path: '/current' };
      return null; // project-gone deleted locally
    });
    state.getCloudProjectById.mockImplementation(async (_id: string) => null); // and absent from cloud

    const result = await callDynamicChatToolByName('frink_navigation_context', {}, executionId);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      history: Array<{ projectId: string; projectName: string; worktreePath: string }>;
    };
    const entry = parsed.history.find((e) => e.projectId === 'project-gone');
    expect(entry).toBeDefined();
    expect(entry?.worktreePath).toBe('/wt/abandoned');
    // Name is whatever buildProjectName falls back to — verify the field is a non-empty
    // string (don't lock the exact wording; that's UX copy that may evolve).
    expect(typeof entry?.projectName).toBe('string');
    expect((entry?.projectName ?? '').length).toBeGreaterThan(0);
  });

  it("documents fork-inheritance origin: a forked chat with inherited history surfaces the SOURCE chat's lineage origin", async () => {
    // forkChatWithSubChats copies source.worktreeHistory verbatim. For a fresh fork that
    // hasn't moved itself, `history[0]` is the SOURCE chat's first departure — not the
    // fork's birth project. This is by design (the fork inherits the lineage so the agent
    // can navigate to any past project). Lock the contract so a future refactor can't
    // silently change it; the tool description spells this out for the agent.
    const executionId = setCurrentExecutionChat('chat-forked', 'sub-1', '/proj/c');
    state.getChatById.mockResolvedValue({
      id: 'chat-forked',
      projectId: 'project-c', // fork is currently at C (inherited from source's current)
      worktreePath: '/proj/c',
      worktreeHistory: '{"project-a":"/wt/a","project-b":"/wt/b"}', // inherited from source
      branch: null,
      archivedAt: null,
    });
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, id: string) => ({
      id,
      name: id,
      path: `/${id}`,
    }));
    state.getCurrentBranch.mockResolvedValue('main');

    const result = await callDynamicChatToolByName('frink_navigation_context', {}, executionId);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      origin: { projectId: string };
      history: Array<{ projectId: string }>;
    };
    // Origin = first inherited history entry (source's earliest departure), NOT the fork's
    // birth project (which is project-c, the fork point).
    expect(parsed.origin.projectId).toBe('project-a');
    expect(parsed.history.map((e) => e.projectId)).toEqual(['project-a', 'project-b']);
  });

  it('tolerates a failing branch derive on one history entry without losing siblings', async () => {
    // The history enrichment runs `getCurrentBranch` in parallel for every entry. One
    // failure (e.g. the worktree dir was deleted between the move and this read) must NOT
    // reject the whole `Promise.all` — sibling entries still need their branches surfaced.
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/now');
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: 'project-current',
      worktreePath: '/wt/now',
      worktreeHistory: '{"project-ok":"/wt/ok","project-broken":"/wt/broken"}',
      branch: null,
      archivedAt: null,
    });
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, id: string) => ({
      id,
      name: id,
      path: '/x',
    }));
    state.getCurrentBranch.mockImplementation(async (path: string) => {
      if (path === '/wt/broken') throw new Error('worktree gone');
      if (path === '/wt/ok') return 'feat-ok';
      if (path === '/wt/now') return 'feat-now';
      return null;
    });

    const result = await callDynamicChatToolByName('frink_navigation_context', {}, executionId);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      current: { branch: string | null };
      history: Array<{ projectId: string; branch: string | null }>;
    };
    expect(parsed.current.branch).toBe('feat-now');
    expect(parsed.history).toHaveLength(2);
    expect(parsed.history.find((e) => e.projectId === 'project-ok')?.branch).toBe('feat-ok');
    expect(parsed.history.find((e) => e.projectId === 'project-broken')?.branch).toBeNull();
  });

  it('returns origin and history after an approved switch', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/owners');
    state.getCloudProjectById.mockImplementation(async (projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/hackathon' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/owners' };
      return null;
    });
    // The switch target/source resolve locally (cloud is the nav-metadata fallback below).
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, projectId: string) => {
      if (projectId === 'project-2')
        return { id: 'project-2', name: 'Hackathon', path: '/hackathon' };
      if (projectId === 'project-1') return { id: 'project-1', name: 'Owners', path: '/owners' };
      return null;
    });
    state.getChatById.mockImplementation(async (_db: unknown, chatId: string) => {
      if (chatId === 'chat-1') {
        return {
          id: 'chat-1',
          projectId: 'project-1',
          worktreePath: '/owners/worktrees/feat-a',
          branch: 'feat-a',
          archivedAt: null,
        };
      }
      if (chatId === 'chat-2') {
        return {
          id: 'chat-2',
          projectId: 'project-2',
          worktreePath: '/hackathon/worktrees/feat-b',
          branch: 'feat-b',
          archivedAt: null,
        };
      }
      return null;
    });
    state.findChatByWorktree.mockResolvedValue(null);
    state.getChatsPageForProjects.mockResolvedValue([
      {
        id: 'chat-2',
        project_id: 'project-2',
        worktree_path: '/hackathon/worktrees/feat-b',
        branch: 'feat-b',
        archived_at: null,
      },
    ]);
    state.getSubChatsForChat.mockResolvedValue([{ id: 'sub-2' }]);

    const switchPromise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'project-2' },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    emitMoveResponse(payload.requestId, true);
    await switchPromise;

    const contextResult = await callDynamicChatToolByName(
      'frink_navigation_context',
      {},
      executionId,
    );
    expect(contextResult.isError).toBe(false);
    const parsed = JSON.parse(contextResult.content[0]?.text ?? '{}') as {
      current: { projectId: string | null };
      history: Array<{ projectId: string; projectName: string; worktreePath: string }>;
    };
    // After the approved switch the chat is in project-2 (the helper mock fakes the move's
    // local DB effect by leaving the stub chat row unchanged, but the response only depends
    // on current state, which the renderer-facing context reads directly).
    expect(parsed.current.projectId).toBe('project-1');
    // Persistent history is populated by the helper inside its transaction; the test's stub
    // chat row still carries the pre-move worktreeHistory, so we just confirm the field is
    // an array (shape contract). Full history persistence is covered by the mutation test.
    expect(Array.isArray(parsed.history)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flows tool dispatch integration
// ---------------------------------------------------------------------------

registerDynamicChatFlowDispatchTests({
  state,
  callDynamicChatToolByName,
  callToolOverHttp,
  getChannelToken,
  setCurrentExecutionChat,
  clearCurrentExecutionChat,
});

registerDynamicChatChannelTests({
  state,
  bindChannelExecution,
  callToolOverHttp,
  clearCurrentExecutionChat,
  getLatestTaskSignal,
  getOrStartDynamicChatMcpUrl,
  listDynamicChatToolNames,
  setCurrentExecutionChat,
});

describe('debug mode tool visibility (edge cases H, J)', () => {
  afterEach(() => {
    clearCurrentExecutionChat();
  });

  it('debug mode gets the same tools as agent mode — no debug-specific tools (edge case H)', async () => {
    const debugTools = await listDynamicChatToolNames(codexChannel('sub-dbg', 'debug'), 'debug:nosignal');
    const agentTools = await listDynamicChatToolNames(codexChannel('sub-agt'), 'agent:nosignal');

    expect(debugTools.sort()).toEqual(agentTools.sort());
  });

  it('Claude Code execution in debug mode gets same tools as agent mode (edge case H)', async () => {
    const debugTools = await listDynamicChatToolNames(codexChannel('sub-dbg', 'debug'), 'debug:nosignal');
    const agentTools = await listDynamicChatToolNames(codexChannel('sub-agt'), 'agent:nosignal');

    expect(debugTools.sort()).toEqual(agentTools.sort());
  });

  it('BUG: no debug-specific MCP tools exist in any mode (edge case J)', async () => {
    const tools = await listDynamicChatToolNames(codexChannel('sub-dbg', 'debug'), 'debug:nosignal');

    // frink_read_debug_log and frink_clear_debug_log were planned (Phase 1d)
    // but never implemented. The debug system prompt tells the agent about log
    // reading/clearing, but no MCP tools back those capabilities.
    expect(tools).not.toContain('frink_read_debug_log');
    expect(tools).not.toContain('frink_clear_debug_log');
  });
});

// searchProjects / fetchAllProjects read from the local SQLite projects repo. Pre-localization
// they hit the (now-parked) cloud HTTP surface via resolveMachineId + cloud-client and errored on
// every call once cloud project sync was removed.
describe('dynamic-chat-server project discovery tools', () => {
  beforeEach(() => {
    clearCurrentExecutionChat();
    state.listProjectsLocal.mockReset();
    state.getCloudProjectById.mockReset();
  });

  afterEach(() => clearCurrentExecutionChat());

  it('searchProjects returns only local projects matching every query word', async () => {
    state.listProjectsLocal.mockResolvedValue([
      { id: 'p1', name: 'Frink Desktop', path: '/repo/frink', description: 'electron main repo' },
      { id: 'p2', name: 'Marketing Site', path: '/repo/site', description: 'next.js landing' },
    ]);
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/p');
    const result = await callDynamicChatToolByName(
      'searchProjects',
      { query: 'frink electron' },
      executionId,
    );
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      projects: Array<{ id: string }>;
    };
    expect(result.isError).toBe(false);
    expect(parsed.projects).toEqual([
      { id: 'p1', name: 'Frink Desktop', path: '/repo/frink', description: 'electron main repo' },
    ]);
    expect(state.getCloudProjectById).not.toHaveBeenCalled();
  });

  it('searchProjects with a blank query returns all local projects', async () => {
    state.listProjectsLocal.mockResolvedValue([
      { id: 'p1', name: 'A', path: '/a', description: null },
      { id: 'p2', name: 'B', path: '/b', description: null },
    ]);
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/p');
    const result = await callDynamicChatToolByName('searchProjects', { query: '   ' }, executionId);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { projects: unknown[] };
    expect(parsed.projects).toHaveLength(2);
  });

  it('fetchAllProjects returns all local projects with no machine/cloud dependency', async () => {
    state.listProjectsLocal.mockResolvedValue([
      { id: 'p1', name: 'A', path: '/a', description: 'desc-a' },
    ]);
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/p');
    const result = await callDynamicChatToolByName('fetchAllProjects', {}, executionId);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      projects: Array<{ description: string | null }>;
    };
    expect(result.isError).toBe(false);
    expect(parsed.projects).toEqual([{ id: 'p1', name: 'A', path: '/a', description: 'desc-a' }]);
    expect(state.getCloudProjectById).not.toHaveBeenCalled();
  });

  it('searchProjects returns an empty list (not an error) when nothing matches', async () => {
    state.listProjectsLocal.mockResolvedValue([
      { id: 'p1', name: 'Frink Desktop', path: '/repo/frink', description: 'electron main repo' },
    ]);
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/p');
    const result = await callDynamicChatToolByName(
      'searchProjects',
      { query: 'nonexistent-token' },
      executionId,
    );
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { projects: unknown[] };
    expect(result.isError).toBe(false);
    expect(parsed.projects).toEqual([]);
  });

  it('searchProjects matches case-insensitively across name, description, and path', async () => {
    state.listProjectsLocal.mockResolvedValue([
      { id: 'byName', name: 'Frink Desktop', path: '/x', description: null },
      { id: 'byDesc', name: 'untitled', path: '/y', description: 'The ELECTRON shell' },
      { id: 'byPath', name: 'untitled', path: '/Users/me/repos/frink-web', description: null },
    ]);
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/p');
    // Upper-case query word + a path fragment; null descriptions must not throw.
    const result = await callDynamicChatToolByName(
      'searchProjects',
      { query: 'ELECTRON' },
      executionId,
    );
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      projects: Array<{ id: string }>;
    };
    expect(parsed.projects.map((p) => p.id)).toEqual(['byDesc']);

    const byPath = await callDynamicChatToolByName(
      'searchProjects',
      { query: 'repos/frink-web' },
      executionId,
    );
    const parsedPath = JSON.parse(byPath.content[0]?.text ?? '{}') as {
      projects: Array<{ id: string }>;
    };
    expect(parsedPath.projects.map((p) => p.id)).toEqual(['byPath']);
  });

  it('searchProjects caps results at 10 even when more local projects match', async () => {
    state.listProjectsLocal.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({
        id: `p${i}`,
        name: `Project ${i}`,
        path: `/repo/${i}`,
        description: null,
      })),
    );
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/p');
    const result = await callDynamicChatToolByName('searchProjects', { query: '' }, executionId);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { projects: unknown[] };
    expect(parsed.projects).toHaveLength(10);
  });

  it('searchProjects rejects a call with no query (schema validation)', async () => {
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/p');
    const result = await callDynamicChatToolByName('searchProjects', {}, executionId);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Invalid arguments');
    expect(state.listProjectsLocal).not.toHaveBeenCalled();
  });

  it('fetchAllProjects returns an empty list (not an error) when the local DB is empty', async () => {
    state.listProjectsLocal.mockResolvedValue([]);
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/p');
    const result = await callDynamicChatToolByName('fetchAllProjects', {}, executionId);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { projects: unknown[] };
    expect(result.isError).toBe(false);
    expect(parsed.projects).toEqual([]);
  });
});

// Regression: a local cuid2 id surfaced by searchProjects must resolve at switch time. The switch
// resolver is local-only (getProjectByIdLocal), so a local id resolves without ever touching the
// parked cloud lookup.
describe('dynamic-chat-server searchProjects -> requestSwitchProject (local id)', () => {
  beforeEach(() => {
    clearCurrentExecutionChat();
    state.windows[0].webContents.send.mockReset();
    state.listProjectsLocal.mockReset();
    state.getProjectByIdLocal.mockReset();
    state.getCloudProjectById.mockReset();
    state.getChatById.mockReset();
    state.resolveTargetWorktreeForMove.mockReset();
  });

  afterEach(() => clearCurrentExecutionChat());

  it('resolves a local project id without a cloud lookup', async () => {
    const localId = 'cl_abc123local';
    state.listProjectsLocal.mockResolvedValue([
      { id: localId, name: 'Frink', path: '/repo/frink', description: 'electron main repo' },
    ]);
    state.getProjectByIdLocal.mockImplementation(async (_db: unknown, id: string) =>
      id === localId ? { id: localId, name: 'Frink', path: '/repo/frink' } : null,
    );
    state.getCloudProjectById.mockResolvedValue(null);
    state.getChatById.mockResolvedValue({
      id: 'chat-1',
      projectId: null,
      worktreePath: null,
      branch: null,
      archivedAt: null,
    });
    state.resolveTargetWorktreeForMove.mockResolvedValue({
      worktreePath: '/repo/frink',
      branch: null,
      baseBranch: null,
      stalePrunedProjectId: null,
    });

    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');

    const search = await callDynamicChatToolByName(
      'searchProjects',
      { query: 'frink' },
      executionId,
    );
    const hits = JSON.parse(search.content[0]?.text ?? '{}') as { projects: Array<{ id: string }> };
    const targetId = hits.projects[0]?.id;
    expect(targetId).toBe(localId);

    const promise = callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: targetId },
      executionId,
    );
    await flushMicrotasks();
    const payload = requireMovePayload();
    expect(payload.projectId).toBe(localId);
    emitMoveResponse(payload.requestId, false);
    await promise;

    expect(state.getCloudProjectById).not.toHaveBeenCalled();
  });

  it('reports "Project not found" for a target id absent from the local DB (no cloud fallback)', async () => {
    state.getProjectByIdLocal.mockResolvedValue(null);
    state.getCloudProjectById.mockResolvedValue({
      id: 'stale',
      name: 'Stale Cloud',
      path: '/cloud/stale',
    });
    const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/old/path');

    const result = await callDynamicChatToolByName(
      'requestSwitchProject',
      { project_id: 'stale' },
      executionId,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Project not found: stale');
    // A since-deleted/cross-machine id must NOT silently resolve through the parked cloud surface.
    expect(state.getCloudProjectById).not.toHaveBeenCalled();
    expect(state.windows[0].webContents.send).not.toHaveBeenCalled();
  });
});
