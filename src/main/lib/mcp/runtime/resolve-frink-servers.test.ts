import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrinkMcpServerConfig } from '../types';

const mocks = vi.hoisted(() => ({
  getGlobalMcpServers: vi.fn(),
  getMcpCredentials: vi.fn(),
  updateMcpCredentialsAtomic: vi.fn(),
  refreshAccessToken: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('electron-log', () => ({ default: mocks.log }));
vi.mock('./oauth-refresh', () => ({ refreshOAuthThroughSdk: mocks.refreshAccessToken }));
vi.mock('../../sentry/init', () => ({ captureMainMessage: vi.fn() }));
vi.mock('../config', () => ({
  getGlobalMcpServers: mocks.getGlobalMcpServers,
  getMcpCredentials: mocks.getMcpCredentials,
  updateMcpCredentialsAtomic: mocks.updateMcpCredentialsAtomic,
}));

import {
  hasUsableOAuth,
  refreshNearExpiryOAuth,
  resolveFrinkMcpServers,
  usableOrRefreshableOAuth,
} from './resolve-frink-servers';

function server(overrides: Partial<FrinkMcpServerConfig>): FrinkMcpServerConfig {
  return {
    name: 'server',
    type: 'custom',
    authType: 'none',
    command: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getGlobalMcpServers.mockResolvedValue({});
  mocks.getMcpCredentials.mockResolvedValue(undefined);
  mocks.updateMcpCredentialsAtomic.mockImplementation(async (update) =>
    update({ servers: { remote: await mocks.getMcpCredentials('remote') } }),
  );
  mocks.refreshAccessToken.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.FRINK_RESOLVER_TEST_PARENT;
  delete process.env.FRINK_RESOLVER_REQUIRED;
});

describe('resolveFrinkMcpServers', () => {
  it('preserves user-owned servers alongside plugin OAuth', async () => {
    mocks.getGlobalMcpServers.mockResolvedValue({
      user_shortcut: server({ command: 'my-shortcut-mcp' }),
      plugin_shortcut_shortcut: server({ url: 'https://mcp.shortcut.com/mcp', managedBy: 'vendor_plugin' }),
    });
    const result = await resolveFrinkMcpServers({ projectPath: '/project' });
    expect(Object.keys(result.servers ?? {})).toEqual(['plugin_shortcut_shortcut', 'user_shortcut']);
  });

  it('preserves Claude server shape while exposing only scoped stdio env separately', async () => {
    process.env.FRINK_RESOLVER_TEST_PARENT = 'parent-only';
    mocks.getGlobalMcpServers.mockResolvedValue({
      '@local': server({
        name: '@local',
        authType: 'env_var',
        command: 'npx @scope/mcp',
        args: ['TOKEN=embedded'],
        requiredEnvVars: ['MCP_TOKEN'],
      }),
      remote: server({
        name: 'remote',
        type: 'cloud_api',
        url: 'https://example.test/mcp',
      }),
    });
    mocks.getMcpCredentials.mockImplementation(async (name: string) =>
      name === '@local'
        ? { env: { MCP_TOKEN: 'stored-token' } }
        : { headers: { Authorization: 'Bearer stored-http-token' } },
    );

    const result = await resolveFrinkMcpServers({
      projectId: 'project-1',
      projectPath: '/work/project',
      dynamicChatMcpUrl: 'http://127.0.0.1:4312/mcp',
    });

    expect(Object.keys(result.servers ?? {})).toEqual(['frink_dynamic_chat', 'remote', 'z_@local']);
    expect(result.servers?.remote).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer stored-http-token' },
    });
    expect(result.servers?.['z_@local']).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@scope/mcp'],
      env: {
        MCP_TOKEN: 'stored-token',
        npm_config_registry: 'https://registry.npmjs.org/',
      },
    });
    expect(result.servers?.['z_@local'].env).not.toHaveProperty('FRINK_RESOLVER_TEST_PARENT');
    expect(result.envByServer).toEqual({
      'z_@local': {
        MCP_TOKEN: 'stored-token',
        npm_config_registry: 'https://registry.npmjs.org/',
      },
    });
    expect(mocks.getMcpCredentials).toHaveBeenCalledTimes(2);
    const loggedValues = JSON.stringify([mocks.log.info.mock.calls, mocks.log.warn.mock.calls]);
    expect(loggedValues).not.toContain('stored-token');
    expect(loggedValues).not.toContain('stored-http-token');
  });

  it('records required process env as scoped input without copying unrelated process env', async () => {
    process.env.FRINK_RESOLVER_REQUIRED = 'shell-secret';
    process.env.FRINK_RESOLVER_TEST_PARENT = 'parent-only';
    mocks.getGlobalMcpServers.mockResolvedValue({
      local: server({
        name: 'local',
        authType: 'env_var',
        command: 'node',
        args: ['server.js'],
        requiredEnvVars: ['FRINK_RESOLVER_REQUIRED'],
      }),
    });

    const result = await resolveFrinkMcpServers({ projectPath: '/work/project' });

    expect(result.envByServer.local).toEqual({ FRINK_RESOLVER_REQUIRED: 'shell-secret' });
    expect(result.envByServer.local).not.toHaveProperty('FRINK_RESOLVER_TEST_PARENT');
    expect(result.servers?.local.env).toMatchObject({
      FRINK_RESOLVER_REQUIRED: 'shell-secret',
    });
    expect(result.servers?.local.env).not.toHaveProperty('FRINK_RESOLVER_TEST_PARENT');
  });

  it('refreshes a near-expiry OAuth credential in Frink before projecting it', async () => {
    mocks.getGlobalMcpServers.mockResolvedValue({
      remote: server({
        name: 'remote',
        type: 'cloud_api',
        url: 'https://example.test/mcp',
      }),
    });
    mocks.getMcpCredentials.mockResolvedValue({
      oauth: {
        accessToken: 'stale-token',
        refreshToken: 'refresh-token',
        clientId: 'client-id',
        expiresAt: Date.now() + 60_000,
      },
    });
    const newExpiry = Date.now() + 3_600_000;
    mocks.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: newExpiry,
    });

    const result = await resolveFrinkMcpServers({ projectPath: '/work/project' });

    expect(result.servers?.remote).toMatchObject({
      headers: { Authorization: 'Bearer fresh-token' },
      _oauth: {
        accessToken: 'fresh-token',
        refreshToken: 'rotated-refresh-token',
        clientId: 'client-id',
        expiresAt: newExpiry,
      },
    });
    expect(mocks.updateMcpCredentialsAtomic).toHaveBeenCalledOnce();
    const written = await mocks.updateMcpCredentialsAtomic.mock.results[0]?.value;
    expect(written.servers.remote).toEqual(
      expect.objectContaining({ oauth: expect.objectContaining({ accessToken: 'fresh-token' }) }),
    );
  });

  it('refreshes every near-expiry OAuth server concurrently and keeps config order', async () => {
    mocks.getGlobalMcpServers.mockResolvedValue({
      first: server({ name: 'first', type: 'cloud_api', url: 'https://first.test/mcp' }),
      second: server({ name: 'second', type: 'cloud_api', url: 'https://second.test/mcp' }),
    });
    mocks.getMcpCredentials.mockResolvedValue({
      oauth: {
        accessToken: 'stale-token',
        refreshToken: 'refresh-token',
        clientId: 'client-id',
        expiresAt: Date.now() + 60_000,
      },
    });
    const pending: Array<(value: unknown) => void> = [];
    mocks.refreshAccessToken.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );

    const result = resolveFrinkMcpServers({ projectPath: '/work/project' });
    await vi.waitFor(() => expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(2));
    for (const finish of pending.reverse()) {
      finish({ accessToken: 'fresh-token', expiresAt: Date.now() + 3_600_000 });
    }

    expect(Object.keys((await result).servers ?? {})).toEqual(['first', 'second']);
  });

  it('projects a near-expiry credential untouched when refresh material is incomplete', async () => {
    // The refresh gate (hasRefreshMaterial) needs refreshToken AND clientId; a
    // partial credential must skip the network refresh, not attempt or corrupt it.
    mocks.getGlobalMcpServers.mockResolvedValue({
      remote: server({ name: 'remote', type: 'cloud_api', url: 'https://example.test/mcp' }),
    });
    mocks.getMcpCredentials.mockResolvedValue({
      oauth: {
        accessToken: 'stale-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
      },
    });

    const result = await resolveFrinkMcpServers({ projectPath: '/work/project' });

    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.updateMcpCredentialsAtomic).not.toHaveBeenCalled();
    expect(result.servers?.remote).toMatchObject({
      _oauth: expect.objectContaining({ accessToken: 'stale-token' }),
    });
  });

  it.each([
    { label: 'a zero deadline', expiresAt: 0 },
    { label: 'a null deadline', expiresAt: null as unknown as number },
  ])('refreshes a credential with $label before projecting it', async ({ expiresAt }) => {
    mocks.getGlobalMcpServers.mockResolvedValue({
      remote: server({ name: 'remote', type: 'cloud_api', url: 'https://example.test/mcp' }),
    });
    mocks.getMcpCredentials.mockResolvedValue({
      oauth: { accessToken: 'stale-token', refreshToken: 'refresh-token', clientId: 'client-id', expiresAt },
    });
    mocks.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-token',
      expiresAt: Date.now() + 3_600_000,
    });

    const result = await resolveFrinkMcpServers({ projectPath: '/work/project' });

    expect(mocks.refreshAccessToken).toHaveBeenCalledOnce();
    expect(result.servers?.remote).toMatchObject({
      headers: { Authorization: 'Bearer fresh-token' },
      _oauth: expect.objectContaining({ accessToken: 'fresh-token' }),
    });
  });

  it('projects a zero-deadline credential untouched when refresh material is incomplete', async () => {
    mocks.getGlobalMcpServers.mockResolvedValue({
      remote: server({ name: 'remote', type: 'cloud_api', url: 'https://example.test/mcp' }),
    });
    mocks.getMcpCredentials.mockResolvedValue({
      oauth: { accessToken: 'stale-token', refreshToken: 'refresh-token', expiresAt: 0 },
    });

    const result = await resolveFrinkMcpServers({ projectPath: '/work/project' });

    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.updateMcpCredentialsAtomic).not.toHaveBeenCalled();
    expect(result.servers?.remote).toMatchObject({
      _oauth: expect.objectContaining({ accessToken: 'stale-token' }),
    });
  });

  it('does not refresh a credential the server granted without an expiry', async () => {
    mocks.getGlobalMcpServers.mockResolvedValue({
      remote: server({ name: 'remote', type: 'cloud_api', url: 'https://example.test/mcp' }),
    });
    mocks.getMcpCredentials.mockResolvedValue({
      oauth: { accessToken: 'eternal-token', refreshToken: 'refresh-token', clientId: 'client-id' },
    });

    const result = await resolveFrinkMcpServers({ projectPath: '/work/project' });

    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(result.servers?.remote).toMatchObject({
      _oauth: expect.objectContaining({ accessToken: 'eternal-token' }),
    });
  });

  it('does not overwrite a credential reconnected while refresh is in flight', async () => {
    const stale = {
      oauth: {
        accessToken: 'stale-token',
        refreshToken: 'refresh-token',
        clientId: 'client-id',
        expiresAt: Date.now() + 60_000,
      },
    };
    const reconnected = {
      oauth: {
        accessToken: 'user-saved-token',
        refreshToken: 'user-saved-refresh',
        clientId: 'new-client-id',
        expiresAt: Date.now() + 3_600_000,
      },
    };
    mocks.getGlobalMcpServers.mockResolvedValue({
      remote: server({ name: 'remote', type: 'cloud_api', url: 'https://example.test/mcp' }),
    });
    mocks.getMcpCredentials.mockResolvedValue(stale);
    mocks.refreshAccessToken.mockResolvedValue({
      accessToken: 'refresh-result-that-must-lose',
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.updateMcpCredentialsAtomic.mockImplementation(async (update) =>
      update({ servers: { remote: reconnected } }),
    );

    const result = await resolveFrinkMcpServers({ projectPath: '/work/project' });

    expect(result.servers?.remote._oauth?.accessToken).toBe('user-saved-token');
    const written = await mocks.updateMcpCredentialsAtomic.mock.results[0]?.value;
    expect(written.servers.remote).toEqual(reconnected);
  });

  it('shares one rotating-token refresh across concurrent Codex turns', async () => {
    mocks.getGlobalMcpServers.mockResolvedValue({
      remote: server({
        name: 'remote',
        type: 'cloud_api',
        url: 'https://example.test/mcp',
      }),
    });
    mocks.getMcpCredentials.mockResolvedValue({
      oauth: {
        accessToken: 'stale-token',
        refreshToken: 'one-use-refresh-token',
        clientId: 'client-id',
        expiresAt: Date.now() + 60_000,
      },
    });
    let finishRefresh: ((value: unknown) => void) | undefined;
    mocks.refreshAccessToken.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );

    const first = resolveFrinkMcpServers({ projectPath: '/work/project' });
    const second = resolveFrinkMcpServers({ projectPath: '/work/project' });
    await vi.waitFor(() => expect(mocks.refreshAccessToken).toHaveBeenCalledOnce());
    finishRefresh?.({
      accessToken: 'fresh-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: Date.now() + 3_600_000,
    });

    const results = await Promise.all([first, second]);
    expect(mocks.refreshAccessToken).toHaveBeenCalledOnce();
    expect(results.map((result) => result.servers?.remote._oauth?.accessToken)).toEqual([
      'fresh-token',
      'fresh-token',
    ]);
  });

  it('keeps the dynamic MCP when canonical config loading fails', async () => {
    mocks.getGlobalMcpServers.mockRejectedValue(new Error('config unavailable'));

    const result = await resolveFrinkMcpServers({
      projectPath: '/work/project',
      dynamicChatMcpUrl: 'http://127.0.0.1:4312/mcp',
    });

    expect(result).toEqual({
      servers: {
        frink_dynamic_chat: { type: 'http', url: 'http://127.0.0.1:4312/mcp' },
      },
      envByServer: {},
    });
    expect(mocks.log.warn).toHaveBeenCalledWith(
      '[Socket Executor] Failed to load MCP servers:',
      expect.any(Error),
    );
  });

  it('does not let configured MCPs replace the trusted dynamic-chat server', async () => {
    mocks.getGlobalMcpServers.mockResolvedValue({
      frink_dynamic_chat: server({
        name: 'frink_dynamic_chat',
        type: 'cloud_api',
        url: 'https://untrusted.example.test/mcp',
      }),
    });

    const result = await resolveFrinkMcpServers({
      projectPath: '/work/project',
      dynamicChatMcpUrl: 'http://127.0.0.1:4312/mcp?channel=trusted',
    });

    expect(result.servers?.frink_dynamic_chat).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4312/mcp?channel=trusted',
    });
  });
});

describe('OAuth expiry predicates', () => {
  const renewable = { refreshToken: 'refresh-token', clientId: 'client-id' };

  it('reads a zero deadline as expired and a missing one as no expiry', () => {
    expect(hasUsableOAuth({ oauth: { accessToken: 'token', expiresAt: 0 } })).toBe(false);
    expect(hasUsableOAuth({ oauth: { accessToken: 'token' } })).toBe(true);
  });

  it('counts a zero-deadline credential as connected only when it can be renewed', () => {
    expect(usableOrRefreshableOAuth({ oauth: { accessToken: 'token', expiresAt: 0, ...renewable } })).toBe(true);
    expect(usableOrRefreshableOAuth({ oauth: { accessToken: 'token', expiresAt: 0 } })).toBe(false);
  });
});

describe('refreshNearExpiryOAuth deadline handling', () => {
  const NOW = 1_800_000_000_000;
  const REFRESH_WINDOW_MS = 5 * 60 * 1000;
  const remote = server({ name: 'remote', type: 'cloud_api', url: 'https://example.test/mcp' });
  const credential = (expiresAt: number | undefined) => ({
    oauth: { accessToken: 'stale-token', refreshToken: 'refresh-token', clientId: 'client-id', expiresAt },
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    mocks.refreshAccessToken.mockResolvedValue({ accessToken: 'fresh-token', expiresAt: NOW + 3_600_000 });
  });

  it.each([
    { label: 'a negative deadline', expiresAt: -1 },
    { label: 'an unparseable deadline', expiresAt: Number.NaN },
    { label: 'a deadline already passed', expiresAt: NOW - 1 },
    { label: 'a deadline exactly on the refresh window', expiresAt: NOW + REFRESH_WINDOW_MS },
  ])('refreshes $label', async ({ expiresAt }) => {
    const stored = credential(expiresAt);
    mocks.getMcpCredentials.mockResolvedValue(stored);

    const result = await refreshNearExpiryOAuth('remote', remote, stored);

    expect(mocks.refreshAccessToken).toHaveBeenCalledOnce();
    expect(result?.oauth?.accessToken).toBe('fresh-token');
  });

  it.each([
    { label: 'a deadline one millisecond outside the refresh window', expiresAt: NOW + REFRESH_WINDOW_MS + 1 },
    { label: 'a far-future deadline', expiresAt: NOW + 3_600_000 },
    { label: 'the largest safe deadline', expiresAt: Number.MAX_SAFE_INTEGER },
  ])('leaves $label alone', async ({ expiresAt }) => {
    const stored = credential(expiresAt);

    const result = await refreshNearExpiryOAuth('remote', remote, stored);

    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(result).toBe(stored);
  });

  it('does not refresh a zero-deadline credential on a server with no url', async () => {
    const stored = credential(0);

    const result = await refreshNearExpiryOAuth('local', server({ name: 'local', command: 'local-mcp' }), stored);

    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(result).toBe(stored);
  });

  it('keeps the stale zero-deadline credential when the refresh is rejected', async () => {
    const stored = credential(0);
    mocks.getMcpCredentials.mockResolvedValue(stored);
    mocks.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    const result = await refreshNearExpiryOAuth('remote', remote, stored);

    expect(result).toBe(stored);
    expect(mocks.updateMcpCredentialsAtomic).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.stringContaining('reconnect is required'));
  });

  it('adopts a credential reconnected while a zero-deadline refresh was failing', async () => {
    const stored = credential(0);
    const reconnected = credential(NOW + 3_600_000);
    mocks.getMcpCredentials.mockResolvedValue(reconnected);
    mocks.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    const result = await refreshNearExpiryOAuth('remote', remote, stored);

    expect(result).toBe(reconnected);
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('retries a zero-deadline refresh on the next call after a rejection', async () => {
    const stored = credential(0);
    mocks.getMcpCredentials.mockResolvedValue(stored);
    mocks.refreshAccessToken.mockRejectedValueOnce(new Error('temporarily_unavailable'));

    await refreshNearExpiryOAuth('remote', remote, stored);
    const second = await refreshNearExpiryOAuth('remote', remote, stored);

    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(second?.oauth?.accessToken).toBe('fresh-token');
  });
});
