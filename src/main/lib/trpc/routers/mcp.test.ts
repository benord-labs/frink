import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  setGlobalMcpServerMock,
  removeGlobalMcpServerMock,
  setMcpCredentialsMock,
  removeMcpCredentialsMock,
  toggleGlobalMcpEnabledMock,
  getGlobalMcpServersMock,
  getMcpCredentialsMock,
  hasMcpCredentialsMock,
  readMcpCredentialsMock,
  fetchMcpToolsMock,
  fetchMcpToolsStdioMock,
  normalizeMcpServerConfigForStorageMock,
  runMcpImporterMock,
  getAllWindowsMock,
} = vi.hoisted(() => ({
  setGlobalMcpServerMock: vi.fn(),
  removeGlobalMcpServerMock: vi.fn(),
  setMcpCredentialsMock: vi.fn(),
  removeMcpCredentialsMock: vi.fn(),
  toggleGlobalMcpEnabledMock: vi.fn(),
  getGlobalMcpServersMock: vi.fn(() => ({})),
  getMcpCredentialsMock: vi.fn(),
  hasMcpCredentialsMock: vi.fn(),
  readMcpCredentialsMock: vi.fn(),
  fetchMcpToolsMock: vi.fn(),
  fetchMcpToolsStdioMock: vi.fn(),
  normalizeMcpServerConfigForStorageMock: vi.fn((config) => {
    if (
      config &&
      typeof config === 'object' &&
      config.authType === 'none' &&
      Array.isArray(config.requiredEnvVars) &&
      config.requiredEnvVars.length > 0
    ) {
      return { ...config, authType: 'env_var' };
    }
    return config;
  }),
  runMcpImporterMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
}));

vi.mock('../../mcp', () => ({
  getGlobalMcpServers: getGlobalMcpServersMock,
  getMcpCredentials: getMcpCredentialsMock,
  hasMcpCredentials: hasMcpCredentialsMock,
  normalizeMcpServerConfigForStorage: normalizeMcpServerConfigForStorageMock,
  readMcpCredentials: readMcpCredentialsMock,
  readProjectLocalMcpConfig: vi.fn(),
  removeGlobalMcpServer: removeGlobalMcpServerMock,
  removeMcpCredentials: removeMcpCredentialsMock,
  setGlobalMcpServer: setGlobalMcpServerMock,
  setMcpCredentials: setMcpCredentialsMock,
}));

vi.mock('../../mcp/config', () => ({
  toggleGlobalMcpEnabled: toggleGlobalMcpEnabledMock,
}));

vi.mock('../../mcp/tools-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/tools-probe')>()),
  fetchMcpToolDescriptors: fetchMcpToolsMock,
  fetchMcpToolDescriptorsStdio: fetchMcpToolsStdioMock,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock'),
  },
  BrowserWindow: {
    getAllWindows: () => getAllWindowsMock(),
  },
}));

vi.mock('../../mcp/importer', () => ({
  runMcpImporter: () => runMcpImporterMock(),
}));

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { _resetClaudeToolsCacheForTests } from '../../mcp/claude-tools-cache';
import {
  __resetSessionsForTest,
  createSession,
  retainSession,
} from '../../socket/claude-session-registry';
import { mcpRouter } from './mcp';

describe('mcpRouter local config', () => {
  beforeEach(() => {
    setGlobalMcpServerMock.mockReset();
    removeGlobalMcpServerMock.mockReset();
    setMcpCredentialsMock.mockReset();
    removeMcpCredentialsMock.mockReset();
    toggleGlobalMcpEnabledMock.mockReset();
    getGlobalMcpServersMock.mockReset();
    getGlobalMcpServersMock.mockResolvedValue({});
    getMcpCredentialsMock.mockReset();
    hasMcpCredentialsMock.mockReset();
    readMcpCredentialsMock.mockReset();
    readMcpCredentialsMock.mockResolvedValue({ servers: {} });
    fetchMcpToolsMock.mockReset();
    fetchMcpToolsStdioMock.mockReset();
    // Probes return Promise<string[]>; honor that contract by default so the
    // shared tool-list cache never stores a non-array.
    fetchMcpToolsMock.mockResolvedValue({ ok: true, tools: [] });
    fetchMcpToolsStdioMock.mockResolvedValue({ ok: true, tools: [] });
    // Shared negative-cache persists across tests + real timers — reset so a
    // prior test's cached probe never bleeds into the next.
    _resetClaudeToolsCacheForTests();
  });

  type Caller = ReturnType<typeof mcpRouter.createCaller>;
  it.each([
    ['removing a server', (caller: Caller) => caller.removeGlobalServer({ name: 'linear' })],
    [
      'disabling a server',
      (caller: Caller) => caller.toggleEnabled({ name: 'linear', enabled: false }),
    ],
    [
      'removing credentials',
      (caller: Caller) => caller.removeCredentials({ serverName: 'linear' }),
    ],
    [
      'importing new native servers',
      (caller: Caller) => {
        getAllWindowsMock.mockReturnValue([]);
        runMcpImporterMock.mockResolvedValueOnce({ imported: 1, conflicts: 0, backfilled: 0 });
        return caller.runImporter();
      },
    ],
  ])('%s retires idle Claude sessions spawned on the old MCP config', async (_change, mutate) => {
    __resetSessionsForTest();
    const close = vi.fn();
    const next = () => new Promise(() => {});
    retainSession(createSession('idle-sub', () => ({ close, next }) as unknown as Query));

    await mutate(mcpRouter.createCaller({ getWindow: () => null }));

    expect(close).toHaveBeenCalledOnce();
  });

  it('normalizes env-var auth in setGlobalServer when requiredEnvVars are present', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    await caller.setGlobalServer({
      name: 'shortcut',
      config: {
        name: 'shortcut',
        type: 'custom',
        authType: 'none',
        command: 'mcp-server-shortcut',
        requiredEnvVars: ['SHORTCUT_API_TOKEN'],
      },
    });

    expect(setGlobalMcpServerMock).toHaveBeenCalledWith(
      'shortcut',
      expect.objectContaining({
        authType: 'env_var',
        requiredEnvVars: ['SHORTCUT_API_TOKEN'],
      }),
    );
  });

  it('preserves authType env_var when requiredEnvVars are not provided', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    await caller.setGlobalServer({
      name: 'shortcut',
      config: {
        name: 'shortcut',
        type: 'custom',
        authType: 'env_var',
        command: 'mcp-server-shortcut',
      },
    });

    expect(setGlobalMcpServerMock).toHaveBeenCalledWith(
      'shortcut',
      expect.objectContaining({
        authType: 'env_var',
      }),
    );
  });

  it('does not normalize to env_var when requiredEnvVars is empty', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    await caller.setGlobalServer({
      name: 'shortcut',
      config: {
        name: 'shortcut',
        type: 'custom',
        authType: 'none',
        command: 'mcp-server-shortcut',
        requiredEnvVars: [],
      },
    });

    expect(setGlobalMcpServerMock).toHaveBeenCalledWith(
      'shortcut',
      expect.objectContaining({
        authType: 'none',
        requiredEnvVars: [],
      }),
    );
  });

  it('marks MCP as needs_auth when required env vars are missing even if tools are discovered', async () => {
    getGlobalMcpServersMock.mockResolvedValue({
      shortcut: {
        name: 'shortcut',
        type: 'custom',
        authType: 'env_var',
        command: 'mcp-server-shortcut',
        requiredEnvVars: ['SHORTCUT_API_TOKEN'],
      },
    });
    readMcpCredentialsMock.mockResolvedValue({
      servers: {
        shortcut: { env: {} },
      },
    });
    fetchMcpToolsStdioMock.mockResolvedValue({ ok: true, tools: [{ name: 'stories-get-by-id' }] });
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    const result = await caller.getAggregatedMcpInfo();
    const shortcut = result.find((mcp) => mcp.name === 'shortcut');

    expect(shortcut?.status).toBe('needs_auth');
    expect(shortcut?.error).toContain('SHORTCUT_API_TOKEN');
  });

  it('marks MCP as connected when tools are discovered and required env vars are satisfied', async () => {
    getGlobalMcpServersMock.mockResolvedValue({
      shortcut: {
        name: 'shortcut',
        type: 'custom',
        authType: 'env_var',
        command: 'mcp-server-shortcut',
        requiredEnvVars: ['SHORTCUT_API_TOKEN'],
      },
    });
    readMcpCredentialsMock.mockResolvedValue({
      servers: {
        shortcut: { env: { SHORTCUT_API_TOKEN: 'token' } },
      },
    });
    fetchMcpToolsStdioMock.mockResolvedValue({ ok: true, tools: [{ name: 'stories-get-by-id' }] });
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    const result = await caller.getAggregatedMcpInfo();
    const shortcut = result.find((mcp) => mcp.name === 'shortcut');

    expect(shortcut?.status).toBe('connected');
    expect(shortcut?.error).toBeUndefined();
  });

  it('degrades gracefully when readMcpCredentials throws', async () => {
    getGlobalMcpServersMock.mockResolvedValue({
      github: {
        name: 'github',
        type: 'custom',
        authType: 'none',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        enabled: true,
      },
    });
    readMcpCredentialsMock.mockRejectedValue(new Error('credentials file unreadable'));

    const caller = mcpRouter.createCaller({ getWindow: () => null });
    const result = await caller.getAggregatedMcpInfo();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'github',
      status: 'disconnected',
    });
  });

  it('ignores malformed credentials.servers payloads', async () => {
    getGlobalMcpServersMock.mockResolvedValue({
      shortcut: {
        name: 'shortcut',
        type: 'custom',
        authType: 'env_var',
        command: 'mcp-server-shortcut',
        requiredEnvVars: ['SHORTCUT_API_TOKEN'],
      },
    });
    readMcpCredentialsMock.mockResolvedValue({
      servers: [] as unknown,
    });

    const caller = mcpRouter.createCaller({ getWindow: () => null });
    const result = await caller.getAggregatedMcpInfo();
    const shortcut = result.find((mcp) => mcp.name === 'shortcut');

    expect(shortcut?.status).toBe('needs_auth');
  });
});

// `runImporter` is a thin wrapper around `runMcpImporter()` whose only job is
// to broadcast `mcp:imported` to all windows. The importer itself is heavily
// covered in `src/main/lib/mcp/importer.test.ts`, so these tests focus on the
// wrapper's two unique responsibilities: result pass-through and broadcast.
describe('mcpRouter runImporter', () => {
  beforeEach(() => {
    runMcpImporterMock.mockReset();
    getAllWindowsMock.mockReset();
  });

  it('returns the importer result and broadcasts to non-destroyed windows', async () => {
    const sendActive = vi.fn();
    const sendDestroyed = vi.fn();
    getAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: sendActive } },
      { isDestroyed: () => true, webContents: { send: sendDestroyed } },
    ]);
    runMcpImporterMock.mockResolvedValue({ imported: 2, conflicts: 0, backfilled: 1 });

    const caller = mcpRouter.createCaller({ getWindow: () => null });
    const result = await caller.runImporter();

    expect(result).toEqual({ imported: 2, conflicts: 0, backfilled: 1 });
    expect(sendActive).toHaveBeenCalledWith('mcp:imported', {
      imported: 2,
      conflicts: 0,
      backfilled: 1,
    });
    expect(sendDestroyed).not.toHaveBeenCalled();
  });

  it('still returns the result when there are no windows to broadcast to', async () => {
    getAllWindowsMock.mockReturnValue([]);
    runMcpImporterMock.mockResolvedValue({ imported: 0, conflicts: 0, backfilled: 0 });

    const caller = mcpRouter.createCaller({ getWindow: () => null });
    const result = await caller.runImporter();

    expect(result).toEqual({ imported: 0, conflicts: 0, backfilled: 0 });
  });
});
