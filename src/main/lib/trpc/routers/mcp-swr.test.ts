import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getGlobalMcpServersMock,
  readMcpCredentialsMock,
  fetchMcpToolsMock,
  fetchMcpToolsStdioMock,
} = vi.hoisted(() => ({
  getGlobalMcpServersMock: vi.fn(),
  readMcpCredentialsMock: vi.fn(),
  fetchMcpToolsMock: vi.fn(),
  fetchMcpToolsStdioMock: vi.fn(),
}));

vi.mock('../../mcp', () => ({
  getGlobalMcpServers: getGlobalMcpServersMock,
  getMcpCredentials: vi.fn(),
  hasMcpCredentials: vi.fn(),
  normalizeMcpServerConfigForStorage: vi.fn((config: unknown) => config),
  readMcpCredentials: readMcpCredentialsMock,
  readProjectLocalMcpConfig: vi.fn(),
  removeGlobalMcpServer: vi.fn(),
  removeMcpCredentials: vi.fn(),
  setGlobalMcpServer: vi.fn(),
  setMcpCredentials: vi.fn(),
}));

vi.mock('../../mcp/config', () => ({ toggleGlobalMcpEnabled: vi.fn() }));

vi.mock('../../mcp/tools-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/tools-probe')>()),
  fetchMcpToolDescriptors: fetchMcpToolsMock,
  fetchMcpToolDescriptorsStdio: fetchMcpToolsStdioMock,
}));

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock') },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../mcp/importer', () => ({ runMcpImporter: vi.fn() }));

import {
  _resetClaudeToolsCacheForTests,
  CLAUDE_TOOLS_CACHE_TTL_MS,
  CLAUDE_TOOLS_NEGATIVE_TTL_MS,
} from '../../mcp/claude-tools-cache';
import { mcpRouter } from './mcp';

// Stale-while-revalidate on the `getAggregatedMcpInfo` tool resolver: a healthy
// server's tool list is served from cache instantly and, once past the TTL,
// re-probed in the background so the NEXT open is fresh — no cold-probe wait.
// A real config/credential change misses on the value-fingerprint and cold-probes.
describe('mcpRouter getAggregatedMcpInfo — stale-while-revalidate', () => {
  const GH_SERVER = {
    gh: {
      name: 'gh',
      type: 'custom',
      authType: 'none',
      command: 'npx',
      args: ['gh-server'],
      enabled: true,
    },
  };
  // Flush the microtask chain so a background revalidation's cache write lands.
  const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    getGlobalMcpServersMock.mockReset().mockResolvedValue(GH_SERVER);
    readMcpCredentialsMock.mockReset().mockResolvedValue({ servers: {} });
    fetchMcpToolsStdioMock.mockReset().mockResolvedValue({ ok: true, tools: [{ name: 'tool_a' }] });
    fetchMcpToolsMock.mockReset().mockResolvedValue({ ok: true, tools: [] });
    _resetClaudeToolsCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const toolsOf = (
    result: Awaited<ReturnType<ReturnType<typeof mcpRouter.createCaller>['getAggregatedMcpInfo']>>,
  ) => result.find((m) => m.name === 'gh')?.tools;

  it('probes once cold, then serves from cache within the TTL (no re-probe)', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_a']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS - 1); // still fresh
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_a']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1); // fresh cache hit, no probe
  });

  it('serves stale tools instantly past the TTL and refreshes in the background', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    await caller.getAggregatedMcpInfo(); // cold → caches ['tool_a']
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS);
    fetchMcpToolsStdioMock.mockResolvedValue({
      ok: true,
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }],
    }); // upstream tools changed

    // Stale entry is served immediately; the background re-probe fires synchronously.
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_a']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2);

    await flushMicrotasks(); // let the background write land

    // Next open now sees the refreshed list from cache — no further probe.
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_a', 'tool_b']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent stale reads to a single background re-probe', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    await caller.getAggregatedMcpInfo(); // cold → 1 probe
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS);
    // Hold the revalidate in-flight across both reads so the dedup is deterministic,
    // then release it so its `.finally` clears the map (no leak into later tests).
    let releaseProbe!: (tools: string[]) => void;
    fetchMcpToolsStdioMock.mockReturnValue(
      new Promise<string[]>((resolve) => {
        releaseProbe = resolve;
      }),
    );

    const [a, b] = await Promise.all([
      caller.getAggregatedMcpInfo(),
      caller.getAggregatedMcpInfo(),
    ]);
    expect(toolsOf(a)).toEqual(['tool_a']); // both served the stale list
    expect(toolsOf(b)).toEqual(['tool_a']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2); // 1 cold + 1 deduped revalidate

    releaseProbe(['tool_a']);
    await flushMicrotasks();
  });

  it('cold-probes (never serves stale) when the config fingerprint changes', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    await caller.getAggregatedMcpInfo(); // caches ['tool_a'] under the no-credential fingerprint
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1);

    // A credential is added mid-TTL → the value-fingerprint changes → hard cache miss.
    readMcpCredentialsMock.mockResolvedValue({ servers: { gh: { env: { GH_TOKEN: 'x' } } } });
    fetchMcpToolsStdioMock.mockResolvedValue({
      ok: true,
      tools: [{ name: 'tool_a' }, { name: 'tool_c' }],
    });

    // Fresh probe result is served immediately, not the stale ['tool_a'].
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_a', 'tool_c']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2);
  });

  it('cold-probes a stale negative (empty) entry so a recovered server is detected', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });
    fetchMcpToolsStdioMock.mockResolvedValue({ ok: true, tools: [] }); // server down → negative-cached []
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual([]);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CLAUDE_TOOLS_NEGATIVE_TTL_MS); // the negative entry ages out
    fetchMcpToolsStdioMock.mockResolvedValue({ ok: true, tools: [{ name: 'tool_a' }] }); // server recovered

    // A stale EMPTY is not served stale — it cold-probes and surfaces the recovery now.
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_a']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2);
  });

  it('serves stale then background-refreshes for a URL/HTTP server too', async () => {
    getGlobalMcpServersMock.mockResolvedValue({
      api: {
        name: 'api',
        type: 'custom',
        authType: 'none',
        url: 'https://mcp.example/api',
        enabled: true,
      },
    });
    fetchMcpToolsMock.mockResolvedValue({ ok: true, tools: [{ name: 'http_tool' }] });
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    const first = await caller.getAggregatedMcpInfo();
    expect(first.find((m) => m.name === 'api')?.tools).toEqual(['http_tool']);
    expect(fetchMcpToolsMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS);
    fetchMcpToolsMock.mockResolvedValue({
      ok: true,
      tools: [{ name: 'http_tool' }, { name: 'http_tool_2' }],
    });

    const stale = await caller.getAggregatedMcpInfo();
    expect(stale.find((m) => m.name === 'api')?.tools).toEqual(['http_tool']); // stale served
    expect(fetchMcpToolsMock).toHaveBeenCalledTimes(2); // background revalidate fired

    await flushMicrotasks();

    const fresh = await caller.getAggregatedMcpInfo();
    expect(fresh.find((m) => m.name === 'api')?.tools).toEqual(['http_tool', 'http_tool_2']);
    expect(fetchMcpToolsMock).toHaveBeenCalledTimes(2); // fresh hit, no new probe
  });

  it('re-arms the dedup map after a successful background revalidation', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    await caller.getAggregatedMcpInfo(); // cold → caches ['tool_a']
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS);
    await caller.getAggregatedMcpInfo(); // stale → serves + one background revalidate
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2);
    await flushMicrotasks(); // revalidation completes → dedup entry clears

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS); // entry stale again
    await caller.getAggregatedMcpInfo(); // a fresh background revalidate must fire again
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(3);
  });

  it('caches empty and reports disconnected when the cold probe throws', async () => {
    fetchMcpToolsStdioMock.mockReset().mockRejectedValue(new Error('spawn ENOENT'));
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    const gh = (await caller.getAggregatedMcpInfo()).find((m) => m.name === 'gh');
    expect(gh?.tools).toEqual([]); // probeServerTools swallows the throw → []
    expect(gh?.status).toBe('disconnected');
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1);
  });

  it('demotes to disconnected on the next open when a background revalidate finds the server down', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });
    await caller.getAggregatedMcpInfo(); // cold → caches ['tool_a']
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS);
    fetchMcpToolsStdioMock.mockResolvedValue({ ok: true, tools: [] }); // server went down since it was cached

    // The one open still serves the last-known tools; the revalidate discovers the outage.
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_a']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2);
    await flushMicrotasks(); // stale entry isn't guard-protected → the empty result overwrites it

    const gh = (await caller.getAggregatedMcpInfo()).find((m) => m.name === 'gh');
    expect(gh?.tools).toEqual([]);
    expect(gh?.status).toBe('disconnected');
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2); // fresh negative served, no new probe
  });

  it('resolves multiple servers independently — per-key cache, per-key revalidation, no cross-leak', async () => {
    getGlobalMcpServersMock.mockResolvedValue({
      gh: {
        name: 'gh',
        type: 'custom',
        authType: 'none',
        command: 'npx',
        args: ['gh'],
        enabled: true,
      },
      sl: {
        name: 'sl',
        type: 'custom',
        authType: 'none',
        command: 'npx',
        args: ['sl'],
        enabled: true,
      },
    });
    // Distinct tools per server so a shared/collided cache or dedup key would show up.
    fetchMcpToolsStdioMock.mockImplementation(async (cfg: { args?: string[] }) =>
      cfg.args?.[0] === 'sl'
        ? { ok: true, tools: [{ name: 'sl_tool' }] }
        : { ok: true, tools: [{ name: 'gh_tool' }] },
    );
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    const first = await caller.getAggregatedMcpInfo(); // cold → one probe each
    expect(first.find((m) => m.name === 'gh')?.tools).toEqual(['gh_tool']);
    expect(first.find((m) => m.name === 'sl')?.tools).toEqual(['sl_tool']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS); // both stale
    fetchMcpToolsStdioMock.mockImplementation(async (cfg: { args?: string[] }) =>
      cfg.args?.[0] === 'sl'
        ? { ok: true, tools: [{ name: 'sl_tool' }, { name: 'sl_2' }] }
        : { ok: true, tools: [{ name: 'gh_tool' }, { name: 'gh_2' }] },
    );

    const stale = await caller.getAggregatedMcpInfo();
    expect(stale.find((m) => m.name === 'gh')?.tools).toEqual(['gh_tool']); // each served its OWN stale list
    expect(stale.find((m) => m.name === 'sl')?.tools).toEqual(['sl_tool']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(4); // 2 cold + 2 independent revalidates
    await flushMicrotasks();

    const fresh = await caller.getAggregatedMcpInfo();
    expect(fresh.find((m) => m.name === 'gh')?.tools).toEqual(['gh_tool', 'gh_2']);
    expect(fresh.find((m) => m.name === 'sl')?.tools).toEqual(['sl_tool', 'sl_2']);
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(4); // both fresh, no new probes
  });

  it('a late stale revalidation does not clobber a fresh newer-fingerprint entry', async () => {
    const caller = mcpRouter.createCaller({ getWindow: () => null });

    // Phase 1: cold, no credentials → cache ['tool_a'] under fingerprint A.
    fetchMcpToolsStdioMock.mockResolvedValueOnce({ ok: true, tools: [{ name: 'tool_a' }] });
    await caller.getAggregatedMcpInfo();

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS); // fingerprint-A entry goes stale

    // Phase 2: the stale read fires a revalidation we hold in-flight (fingerprint A).
    let releaseRevalidate!: (t: string[]) => void;
    fetchMcpToolsStdioMock.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        releaseRevalidate = resolve;
      }),
    );
    await caller.getAggregatedMcpInfo(); // serves stale ['tool_a'] + revalidate A in-flight

    // Phase 3: credentials change (fingerprint B); a cold read writes fresh ['tool_b'].
    readMcpCredentialsMock.mockResolvedValue({ servers: { gh: { env: { GH_TOKEN: 'x' } } } });
    fetchMcpToolsStdioMock.mockResolvedValueOnce({ ok: true, tools: [{ name: 'tool_b' }] });
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_b']);

    // Phase 4: the old fingerprint-A revalidation finishes LAST — it must be dropped,
    // not overwrite fingerprint-B's fresh entry.
    releaseRevalidate(['tool_a']);
    await flushMicrotasks();

    const probesBefore = fetchMcpToolsStdioMock.mock.calls.length;
    expect(toolsOf(await caller.getAggregatedMcpInfo())).toEqual(['tool_b']); // B survives
    expect(fetchMcpToolsStdioMock).toHaveBeenCalledTimes(probesBefore); // no needless re-probe
  });
});
