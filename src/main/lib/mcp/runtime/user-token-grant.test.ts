import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectUserTokenMcp } from './user-token-grant';

const { listMock, persistMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  persistMock: vi.fn(async () => {}),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('./vendor-plugin-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vendor-plugin-oauth')>()),
  listConnectableVendorPluginMcp: listMock,
  persistUserToken: persistMock,
}));

const github = {
  serverName: 'plugin_github_github',
  pluginName: 'github',
  url: 'https://api.githubcopilot.com/mcp/',
  auth: {
    kind: 'user_token' as const,
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    validation: { url: 'https://api.github.com/user' },
  },
};
const slack = {
  serverName: 'plugin_slack_slack',
  pluginName: 'slack',
  url: 'https://mcp.slack.com/mcp',
  auth: { kind: 'static_client' as const, clientId: 'c', callbackPort: 3118 },
};

describe('connectUserTokenMcp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([slack, github]);
  });

  it('validates the token against the vendor with the bearer, then stores it', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(connectUserTokenMcp('github', 'ghp_x', fetchFn)).resolves.toEqual(['plugin_github_github']);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_x');
    expect(persistMock).toHaveBeenCalledExactlyOnceWith(github, 'ghp_x');
  });

  it('stores nothing when the vendor rejects the token, and says so with the status', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 401 }));
    await expect(connectUserTokenMcp('github', 'bad', fetchFn)).rejects.toThrow(/rejected \(HTTP 401\)/);
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('refuses a plugin without a token server: an OAuth server is never fed a pasted token', async () => {
    const fetchFn = vi.fn();
    await expect(connectUserTokenMcp('slack', 'x', fetchFn)).rejects.toThrow(/does not take a token/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
