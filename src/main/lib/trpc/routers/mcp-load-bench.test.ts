/**
 * MCP-load latency bench (sc-1100, epic 1099) — measures the REAL UI MCP-list load paths:
 * `mcpRouter.getAggregatedMcpInfo` (parallel probes) and `getAllMcpConfigHandler` (serial
 * groups + token refresh), with the probe layer mocked to deterministic, pinned delays.
 *
 * NOT part of the normal suite — gated on BENCH=1 so it never slows CI:
 *   run:            BENCH=1 bun run test:run src/main/lib/trpc/routers/mcp-load.bench.test.ts
 *
 * Delays are scaled ~20× down from reality (probe timeout 10s → dead fixture 500ms) so the
 * bench runs in seconds while exposing the same STRUCTURE: serial groups vs parallel probes,
 * the failed-probe OAuth-metadata amplification, and cache behaviour on the warm pass
 * (the claude cache refuses to store empties, so dead servers re-probe every load).
 * The `ensureMcpTokensFresh` mock charges one flat round-trip per call — it models the
 * handler-level serial awaits, not that function's internal loop.
 */
import { describe, expect, it, vi } from 'vitest';

const {
  fetchMcpToolsMock,
  fetchMcpToolsStdioMock,
  ensureMcpTokensFreshMock,
  fetchOAuthMetadataMock,
  getGlobalMcpServersMock,
  readClaudeConfigMock,
} = vi.hoisted(() => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const DELAYS = { fast: 20, slow: 300, dead: 500, refresh: 30, oauthMeta: 50 };
  // Fixture identity travels in args[0] (stdio) / the url tail (http).
  const probe = async (name: string): Promise<{ ok: true; tools: Array<{ name: string }> }> => {
    if (name.includes('dead')) {
      await sleep(DELAYS.dead);
      throw new Error('probe timeout (modeled)');
    }
    await sleep(name.includes('slow') ? DELAYS.slow : DELAYS.fast);
    return { ok: true, tools: [{ name: 'tool_alpha' }, { name: 'tool_beta' }] };
  };
  return {
    fetchMcpToolsMock: vi.fn(
      async (url: string, _headers?: Record<string, string>, _name?: string) =>
        probe(String(url).split('/').pop() ?? ''),
    ),
    fetchMcpToolsStdioMock: vi.fn(async (cfg: { args?: string[] }, _name?: string) =>
      probe(cfg.args?.[0] ?? ''),
    ),
    ensureMcpTokensFreshMock: vi.fn(async (servers: unknown) => {
      await sleep(DELAYS.refresh); // one modeled refresh round-trip per handler await-site
      return servers;
    }),
    fetchOAuthMetadataMock: vi.fn(async (): Promise<{ authorization_endpoint?: string } | null> => {
      await sleep(DELAYS.oauthMeta); // the failed-probe amplification (claude.ts:172-175)
      return null;
    }),
    getGlobalMcpServersMock: vi.fn(),
    readClaudeConfigMock: vi.fn(),
  };
});

vi.mock('../../mcp', () => ({
  getGlobalMcpServers: getGlobalMcpServersMock,
  getMcpCredentials: vi.fn(async () => null),
  hasMcpCredentials: vi.fn(async () => false),
  readMcpCredentials: vi.fn(async () => ({ servers: {} })),
  normalizeMcpServerConfigForStorage: vi.fn((c: unknown) => c),
  readProjectLocalMcpConfig: vi.fn(async () => null),
  removeGlobalMcpServer: vi.fn(),
  removeMcpCredentials: vi.fn(),
  setGlobalMcpServer: vi.fn(),
  setMcpCredentials: vi.fn(),
}));
vi.mock('../../mcp/config', () => ({
  toggleGlobalMcpEnabled: vi.fn(),
  readMcpConfig: vi.fn(async () => ({ servers: {} })), // no frink-owned dedup
}));
vi.mock('../../mcp/tools-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/tools-probe')>()),
  fetchMcpToolDescriptors: fetchMcpToolsMock,
  fetchMcpToolDescriptorsStdio: fetchMcpToolsStdioMock,
}));
vi.mock('../../mcp-auth', () => ({
  ensureMcpTokensFresh: ensureMcpTokensFreshMock,
  getMcpAuthStatus: vi.fn(async () => ({ status: 'none' })),
  startMcpOAuth: vi.fn(),
}));
vi.mock('../../claude-config', () => ({
  GLOBAL_MCP_PATH: '/mock/global',
  readClaudeConfig: readClaudeConfigMock,
  getProjectMcpServers: vi.fn(async () => ({})),
}));
vi.mock('../../oauth', () => ({
  fetchOAuthMetadata: fetchOAuthMetadataMock,
  getMcpBaseUrl: vi.fn((u: string) => u),
}));
vi.mock('../../db', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('../../db/repos/projects', () => ({ listProjects: vi.fn(async () => []) }));
// Spread the real module: the executor also imports the park builder + its messages from here, and
// a bare object mock would hand it `undefined` for those as a runtime error ts:check cannot see.
vi.mock('../../claude/ask-user-question-approval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../claude/ask-user-question-approval')>()),
  clearPendingApprovals: vi.fn(),
  pendingToolApprovals: new Map(),
}));
vi.mock('../../mcp/importer', () => ({ runMcpImporter: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'home' ? '/mock/home' : '/mock') },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  const homedir = () => '/mock/home'; // ~/.cursor/mcp.json read misses → group skipped
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { getAllMcpConfigHandler } from './claude-mcp-config';
import { mcpRouter } from './mcp';

// ---- fixtures: 6 fast (20ms) + 6 slow (300ms) + 2 dead (500ms→fail) per group ----
const mix = (prefix: string, fast: number, slow: number, dead: number) => {
  const names = [
    ...Array.from({ length: fast }, (_, i) => `${prefix}fast-${i}`),
    ...Array.from({ length: slow }, (_, i) => `${prefix}slow-${i}`),
    ...Array.from({ length: dead }, (_, i) => `${prefix}dead-${i}`),
  ];
  return Object.fromEntries(names.map((n) => [n, { command: 'fake-mcp', args: [n] }]));
};
const frinkFixture = Object.fromEntries(
  Object.entries(mix('', 6, 6, 2)).map(([n, c]) => [
    n,
    { name: n, type: 'custom', authType: 'none', enabled: true, ...c },
  ]),
);
const claudeFixture = {
  mcpServers: mix('', 6, 6, 2), // Global group
  projects: {
    '/proj/alpha': { mcpServers: mix('alpha-', 1, 1, 1) },
    '/proj/beta': { mcpServers: mix('beta-', 1, 1, 1) },
  },
};

const timeMs = async (fn: () => Promise<unknown>): Promise<number> => {
  const t0 = performance.now();
  await fn();
  return Math.round(performance.now() - t0);
};

describe('getAllMcpConfigHandler group assembly (parallel build)', () => {
  it('preserves deterministic group order even when later groups finish first', async () => {
    // beta is all-fast (finishes first), alpha is slow-heavy — order must stay config order.
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: mix('ord-g-', 1, 0, 0),
      projects: {
        '/proj/alpha': { mcpServers: mix('ord-a-', 0, 2, 0) }, // slow group
        '/proj/beta': { mcpServers: mix('ord-b-', 2, 0, 0) }, // fast group
      },
    });
    const { groups } = await getAllMcpConfigHandler();
    expect(groups.map((g) => g.groupName)).toEqual(['Global', 'alpha', 'beta']);
    expect(groups[1]?.mcpServers.map((s) => s.status)).toEqual(['connected', 'connected']);
  });

  it('shares one probe per server when two loads overlap, instead of spawning a second set', async () => {
    // Fresh-only, and the entry lands only once the probe resolves, so overlapping loads
    // would otherwise each spawn a full set of stdio children.
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: mix('dedup-', 0, 2, 0),
      projects: {},
    });
    const probesFor = (prefix: string) =>
      fetchMcpToolsStdioMock.mock.calls.filter(([cfg]) =>
        String(cfg.args?.[0] ?? '').startsWith(prefix),
      ).length;

    const [first, second] = await Promise.all([getAllMcpConfigHandler(), getAllMcpConfigHandler()]);

    expect(probesFor('dedup-')).toBe(2);
    expect(first.groups[0]?.mcpServers.map((s) => s.tools)).toEqual(
      second.groups[0]?.mcpServers.map((s) => s.tools),
    );
  });

  it('re-probes a server whose credential rotated mid-flight, never joining the stale probe', async () => {
    // The shared cache makes a fingerprint mismatch a hard miss so it can "never serve
    // another config's tools"; an in-flight probe keyed on the key alone bypasses that.
    const withToken = (token: string) => ({
      'rot-slow-0': {
        url: 'https://mcp.example/rot-slow-0',
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    readClaudeConfigMock.mockResolvedValueOnce({ mcpServers: withToken('old'), projects: {} });
    readClaudeConfigMock.mockResolvedValueOnce({ mcpServers: withToken('new'), projects: {} });
    const before = fetchMcpToolsMock.mock.calls.length;

    await Promise.all([getAllMcpConfigHandler(), getAllMcpConfigHandler()]);

    const sent = fetchMcpToolsMock.mock.calls
      .slice(before)
      .map(([, headers]) => headers?.Authorization);
    expect(sent.sort()).toEqual(['Bearer new', 'Bearer old']);
  });

  it('keeps same-named servers in different project groups on their own probes', async () => {
    // Two projects may configure the same name with byte-identical config: same fingerprint,
    // different key. Collapsing them would show one project's group in the other.
    const server = { 'dup-slow-0': { command: 'fake-mcp', args: ['dup-slow-0'] } };
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: server,
      projects: { '/proj/one': { mcpServers: server }, '/proj/two': { mcpServers: server } },
    });
    const before = fetchMcpToolsStdioMock.mock.calls.length;

    await getAllMcpConfigHandler();

    const probed = fetchMcpToolsStdioMock.mock.calls
      .slice(before)
      .filter(([cfg]) => cfg.args?.[0] === 'dup-slow-0');
    expect(probed).toHaveLength(3); // global + two projects
  });

  it('coerces a numeric env value or arg instead of dropping the whole field', async () => {
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: {
        'num-fast-0': {
          command: 'fake-mcp',
          args: ['num-fast-0', '--port', 8080],
          env: { API_KEY: 'k', PORT: 3000 },
        },
      },
      projects: {},
    });
    await getAllMcpConfigHandler();
    const call = fetchMcpToolsStdioMock.mock.calls.find(([c]) => c.args?.[0] === 'num-fast-0');
    expect(call?.[0]).toMatchObject({
      args: ['num-fast-0', '--port', '8080'],
      env: { API_KEY: 'k', PORT: '3000' },
    });
  });

  it('always emits the Global group, even with no global servers configured', async () => {
    readClaudeConfigMock.mockResolvedValue({ projects: {} });
    const { groups } = await getAllMcpConfigHandler();
    expect(groups.map((g) => g.groupName)).toEqual(['Global']);
    expect(groups[0]?.mcpServers).toEqual([]);
  });

  it('flags a failed HTTP probe as needs-auth when OAuth metadata advertises an auth endpoint', async () => {
    fetchOAuthMetadataMock.mockResolvedValueOnce({
      authorization_endpoint: 'https://auth.example/authorize',
    });
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: { 'authy-dead': { url: 'https://mcp.example/authy-dead' } },
      projects: {},
    });
    const { groups } = await getAllMcpConfigHandler();
    const server = groups[0]?.mcpServers.find((s) => s.name === 'authy-dead');
    expect(server?.needsAuth).toBe(true);
    expect(server?.status).toBe('needs-auth');
  });

  it('keeps a failed HTTP probe on the assume-no-auth path when OAuth metadata is absent', async () => {
    // default fetchOAuthMetadata mock resolves null
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: { 'plain-dead': { url: 'https://mcp.example/plain-dead' } },
      projects: {},
    });
    const { groups } = await getAllMcpConfigHandler();
    const server = groups[0]?.mcpServers.find((s) => s.name === 'plain-dead');
    expect(server?.needsAuth).toBe(false);
    expect(server?.status).toBe('connected');
  });

  it('honors explicit authType — a public (none) HTTP server is never probed or flipped to needs-auth', async () => {
    fetchOAuthMetadataMock.mockClear();
    // metadata WOULD advertise auth, but authType:'none' must short-circuit before the probe
    fetchOAuthMetadataMock.mockResolvedValue({
      authorization_endpoint: 'https://auth.example/authorize',
    });
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: { 'public-dead': { url: 'https://mcp.example/public-dead', authType: 'none' } },
      projects: {},
    });
    const { groups } = await getAllMcpConfigHandler();
    const server = groups[0]?.mcpServers.find((s) => s.name === 'public-dead');
    expect(server?.needsAuth).toBe(false);
    expect(server?.status).toBe('connected');
    expect(fetchOAuthMetadataMock).not.toHaveBeenCalled();
  });
});

describe.runIf(process.env.BENCH === '1')('mcp-load bench (BENCH=1)', () => {
  it('measures the real UI MCP-load paths (cold + warm) and reports vs baseline', async () => {
    readClaudeConfigMock.mockResolvedValue(claudeFixture);
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    // Warm-up the module graph (JIT/import costs) with an EMPTY fixture so the timed cold
    // pass below is genuinely cold — warming with the real fixture would populate the
    // 5-min toolsCache and turn "cold" into a cache-hit.
    getGlobalMcpServersMock.mockResolvedValue({});
    await caller.getAggregatedMcpInfo().catch(() => {});
    getGlobalMcpServersMock.mockResolvedValue(frinkFixture);

    const aCold = await timeMs(() => caller.getAggregatedMcpInfo());
    const aWarm = await timeMs(() => caller.getAggregatedMcpInfo());
    const bCold = await timeMs(() => getAllMcpConfigHandler());
    const bWarm = await timeMs(() => getAllMcpConfigHandler());

    const rows = [
      ['getAggregatedMcpInfo (parallel probes)', aCold, aWarm],
      ['getAllMcpConfig (serial groups+refresh)', bCold, bWarm],
    ]
      .map(
        ([n, c, w]) =>
          `  ${String(n).padEnd(42)} cold ${String(c).padStart(6)}ms   warm ${String(w).padStart(6)}ms`,
      )
      .join('\n');
    process.stdout.write(`\n=== MCP-load bench ===\n${rows}\n`);

    // Structural sanity only (loose — a bench reports, it doesn't gate on timing here):
    // negative caching must make a warm re-load materially cheaper than the cold probe,
    // since dead/slow servers now cache-hit instead of re-probing at full cost every load.
    // (Robust under CPU contention: warm has no probes, so it stays far below cold even
    // when both inflate.) The old "B slower than A" ordering is gone — sc-1090 parallelized B.
    expect(bWarm).toBeLessThan(bCold);
  }, 60_000);
});
