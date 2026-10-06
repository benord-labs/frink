/**
 * Covers the tools-probe folder surface: descriptor probes (schema retained,
 * failures typed), the legacy name-only wrappers' swallow-to-[] contract, the
 * one-shot tool-call path, and `callServerTool` transport routing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  connectMock,
  listToolsMock,
  callToolMock,
  closeMock,
  httpTransportMock,
  stdioTransportMock,
  captureMainMessageMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  listToolsMock: vi.fn(),
  callToolMock: vi.fn(),
  closeMock: vi.fn(),
  httpTransportMock: vi.fn(),
  stdioTransportMock: vi.fn(),
  captureMainMessageMock: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connectMock;
    listTools = listToolsMock;
    callTool = callToolMock;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) {
      httpTransportMock(url, options);
    }
    close = closeMock;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: unknown) {
      stdioTransportMock(options);
    }
    close = closeMock;
  },
}));

vi.mock('../../claude/env', () => ({
  getClaudeShellEnvironment: () => ({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'blocked-secret' }),
}));

vi.mock('../claude-tools-cache', () => ({ refreshClaudeToolsCache: vi.fn() }));

vi.mock('../../sentry/init', () => ({ captureMainMessage: captureMainMessageMock }));

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { LoginShellEnvResolver, setLoginShellEnvResolver } from '../../platform/login-shell-env';
import type { FrinkMcpServerConfig } from '../types';
import {
  _resetMcpPaginationCaptureForTests,
  fetchMcpToolDescriptors,
  fetchMcpToolDescriptorsStdio,
  MAX_TOOL_LIST_PAGES,
  toolNames,
} from '.';
import { callMcpTool, callMcpToolStdio } from './call';
import { callServerTool } from './resolve';
import {
  _resetMcpFailureCaptureForTests,
  MCP_CALL_TIMEOUT_MS,
  MCP_HTTP_CONNECT_TIMEOUT_MS,
  MCP_OPERATION_TIMEOUT_MS,
  MCP_STDIO_CONNECT_TIMEOUT_MS,
  outerGuardMs,
} from './transport';

const sampleTool = {
  name: 'create_story',
  description: 'Create a story',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
};

const baseConfig: FrinkMcpServerConfig = {
  name: 'Test Server',
  type: 'custom',
  authType: 'none',
  command: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetMcpFailureCaptureForTests();
  _resetMcpPaginationCaptureForTests();
  connectMock.mockResolvedValue(undefined);
});

/** Answer the login-shell resolver from a fake shell; `gate` holds the answer until released. */
function loginShellAnswers(gate?: Promise<void>): void {
  setLoginShellEnvResolver(
    new LoginShellEnvResolver({
      spawnShell: async () => {
        await gate;
        return { ok: true, env: { PATH: process.env.PATH ?? '' } };
      },
      extendPath: (p) => p ?? '',
    }),
  );
}

beforeEach(() => loginShellAnswers());

describe('fetchMcpToolDescriptors / fetchMcpToolDescriptorsStdio', () => {
  it('preserves description and inputSchema over HTTP, passing headers through', async () => {
    listToolsMock.mockResolvedValue({ tools: [sampleTool] });
    const result = await fetchMcpToolDescriptors('https://mcp.example/mcp', {
      Authorization: 'Bearer x',
    });
    expect(result).toEqual({ ok: true, tools: [sampleTool] });
    expect(httpTransportMock).toHaveBeenCalledWith(new URL('https://mcp.example/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer x' } },
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['tool-list probe', () => fetchMcpToolDescriptorsStdio({ command: 'npx' })],
    ['one-shot tool call', () => callMcpToolStdio({ command: 'npx' }, 'search', {})],
  ])('waits for the login-shell PATH before spawning a stdio server (%s, sc-4724)', async (_, run) => {
    // A probe at startup (MCP cache warm-up, Settings → test) would otherwise spawn npx on the
    // GUI launch PATH and report the server as broken.
    listToolsMock.mockResolvedValue({ tools: [] });
    callToolMock.mockResolvedValue({ content: [] });
    let release: () => void = () => {};
    loginShellAnswers(new Promise<void>((resolve) => (release = resolve)));

    const pending = run();
    await Promise.resolve();
    expect(stdioTransportMock).not.toHaveBeenCalled();

    release();
    await pending;
    expect(stdioTransportMock).toHaveBeenCalledTimes(1);
  });

  it('preserves inputSchema over stdio and filters blocked env vars from the spawn', async () => {
    listToolsMock.mockResolvedValue({ tools: [sampleTool] });
    const result = await fetchMcpToolDescriptorsStdio({
      command: 'npx',
      args: ['-y', 'srv'],
      env: { FOO: '1' },
    });
    expect(result).toEqual({ ok: true, tools: [sampleTool] });
    const spawn = stdioTransportMock.mock.calls[0][0];
    expect(spawn.command).toBe('npx');
    expect(spawn.args).toEqual(['-y', 'srv']);
    expect(spawn.env.FOO).toBe('1');
    expect(spawn.env.PATH).toBe('/usr/bin');
    expect(spawn.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('reports a server with zero tools as ok — an empty list is a success, not a failure', async () => {
    listToolsMock.mockResolvedValue({ tools: [] });
    expect(await fetchMcpToolDescriptors('https://mcp.example')).toEqual({ ok: true, tools: [] });
  });

  it('reports a connect timeout as a typed failure, never an empty tool list', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReturnValue(new Promise(() => {}));
      const pending = fetchMcpToolDescriptors('https://mcp.example');
      await vi.advanceTimersByTimeAsync(outerGuardMs(MCP_HTTP_CONNECT_TIMEOUT_MS));
      expect(await pending).toEqual({ ok: false, reason: 'timeout', message: 'MCP fetch timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a stdio spawn failure as spawn_failed', async () => {
    connectMock.mockRejectedValue(
      Object.assign(new Error('spawn no-such-cmd ENOENT'), { code: 'ENOENT' }),
    );
    expect(await fetchMcpToolDescriptorsStdio({ command: 'no-such-cmd' })).toEqual({
      ok: false,
      reason: 'spawn_failed',
      message: 'spawn no-such-cmd ENOENT',
    });
  });

  it('never classifies an HTTP error as spawn_failed, even when it mimics a spawn error', async () => {
    connectMock.mockRejectedValue(
      Object.assign(new Error('spawn quota exceeded on remote worker'), { code: 'ENOENT' }),
    );
    expect(await fetchMcpToolDescriptors('https://mcp.example')).toEqual({
      ok: false,
      reason: 'transport',
      message: 'spawn quota exceeded on remote worker',
    });
  });

  it('reports other connect errors as transport failures', async () => {
    connectMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchMcpToolDescriptors('https://mcp.example')).toEqual({
      ok: false,
      reason: 'transport',
      message: 'ECONNREFUSED',
    });
  });
});

describe('toolNames projection (names-or-empty contract)', () => {
  it('projects descriptors to names', async () => {
    listToolsMock.mockResolvedValue({
      tools: [sampleTool, { name: 'list_stories', inputSchema: { type: 'object' } }],
    });
    expect(toolNames(await fetchMcpToolDescriptors('https://mcp.example'))).toEqual([
      'create_story',
      'list_stories',
    ]);
  });

  it('projects every typed failure to an empty array; the transport classifier owns capture', async () => {
    connectMock.mockRejectedValue(new Error('boom'));
    expect(toolNames(await fetchMcpToolDescriptors('https://mcp.example'))).toEqual([]);
    expect(toolNames(await fetchMcpToolDescriptorsStdio({ command: 'x' }))).toEqual([]);
    expect(captureMainMessageMock).toHaveBeenCalledTimes(2);
    expect(captureMainMessageMock).toHaveBeenCalledWith(
      'MCP http transport failure (transport): boom',
      'warning',
      expect.objectContaining({
        surface: 'mcp-transport',
        transport: 'http',
        reason: 'transport',
        step: 'connect',
      }),
      ['mcp-transport', 'http', 'transport'],
    );
  });

  it('does not capture on success', async () => {
    listToolsMock.mockResolvedValue({ tools: [sampleTool] });
    toolNames(await fetchMcpToolDescriptors('https://mcp.example'));
    expect(captureMainMessageMock).not.toHaveBeenCalled();
  });
});

describe('callMcpTool / callMcpToolStdio', () => {
  it('calls the named tool once with arguments and closes the transport', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
    const result = await callMcpTool('https://mcp.example', 'create_story', { title: 'S' });
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith(
      { name: 'create_story', arguments: { title: 'S' } },
      undefined,
      { timeout: MCP_CALL_TIMEOUT_MS },
    );
    expect(result).toEqual({ ok: true, result: { content: [{ type: 'text', text: 'done' }] } });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('returns a typed failure on tool error and still closes the transport', async () => {
    callToolMock.mockRejectedValue(new Error('tool exploded'));
    const result = await callMcpTool('https://mcp.example', 't', {});
    expect(result).toEqual({ ok: false, reason: 'transport', message: 'tool exploded' });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('reports a stdio spawn failure as spawn_failed', async () => {
    connectMock.mockRejectedValue(
      Object.assign(new Error('spawn no-such-cmd ENOENT'), { code: 'ENOENT' }),
    );
    const result = await callMcpToolStdio({ command: 'no-such-cmd' }, 't', {});
    expect(result).toEqual({
      ok: false,
      reason: 'spawn_failed',
      message: 'spawn no-such-cmd ENOENT',
    });
    expect(callToolMock).not.toHaveBeenCalled();
  });
});

describe('callServerTool transport routing', () => {
  it('routes a url config over HTTP with credential headers, never stdio', async () => {
    callToolMock.mockResolvedValue({ content: [] });
    const result = await callServerTool(
      { ...baseConfig, url: 'https://mcp.example/mcp' },
      { headers: { 'X-Key': 'k' } },
      'create_story',
      { title: 'S' },
    );
    expect(result).toEqual({ ok: true, result: { content: [] } });
    expect(httpTransportMock).toHaveBeenCalledWith(new URL('https://mcp.example/mcp'), {
      requestInit: { headers: { 'X-Key': 'k' } },
    });
    expect(stdioTransportMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('routes a command config over stdio with credential env, never HTTP', async () => {
    callToolMock.mockResolvedValue({ content: [] });
    const result = await callServerTool(
      { ...baseConfig, command: 'npx', args: ['-y', 'srv'] },
      { env: { TOKEN: 't' } },
      'create_story',
      {},
    );
    expect(result).toEqual({ ok: true, result: { content: [] } });
    const spawn = stdioTransportMock.mock.calls[0][0];
    expect(spawn.command).toBe('npx');
    expect(spawn.env.TOKEN).toBe('t');
    expect(httpTransportMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('fails typed without spawning anything when the config has neither url nor command', async () => {
    const result = await callServerTool(baseConfig, null, 't', {});
    expect(result).toEqual({
      ok: false,
      reason: 'transport',
      message: 'MCP server config has neither url nor command',
    });
    expect(httpTransportMock).not.toHaveBeenCalled();
    expect(stdioTransportMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe('timeout budgets', () => {
  it('hands each step its own budget to the SDK rather than racing it blind', async () => {
    listToolsMock.mockResolvedValue({ tools: [sampleTool] });
    await fetchMcpToolDescriptors('https://mcp.example');
    expect(connectMock).toHaveBeenCalledWith(expect.anything(), {
      timeout: MCP_HTTP_CONNECT_TIMEOUT_MS,
    });
    expect(listToolsMock).toHaveBeenCalledWith(undefined, { timeout: MCP_OPERATION_TIMEOUT_MS });
  });

  it('gives only a stdio connect the cold-start budget — HTTP spawns nothing', async () => {
    callToolMock.mockResolvedValue({ content: [] });
    await callMcpTool('https://mcp.example', 't', {});
    await callMcpToolStdio({ command: 'npx' }, 't', {});
    expect(connectMock.mock.calls.map(([, options]) => options)).toEqual([
      { timeout: MCP_HTTP_CONNECT_TIMEOUT_MS },
      { timeout: MCP_STDIO_CONNECT_TIMEOUT_MS },
    ]);
  });

  it('keeps the outer guard strictly larger than every SDK budget it wraps', () => {
    // If the guard matched or undercut the SDK budget it would win the race, and the
    // request would be abandoned rather than cancelled.
    for (const budget of [
      MCP_STDIO_CONNECT_TIMEOUT_MS,
      MCP_HTTP_CONNECT_TIMEOUT_MS,
      MCP_OPERATION_TIMEOUT_MS,
      MCP_CALL_TIMEOUT_MS,
    ]) {
      expect(outerGuardMs(budget)).toBeGreaterThan(budget);
    }
  });

  it("classifies the SDK's own request timeout as a timeout, not a transport fault", async () => {
    connectMock.mockRejectedValue(
      new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: 30_000 }),
    );
    expect(await fetchMcpToolDescriptors('https://mcp.example')).toEqual({
      ok: false,
      reason: 'timeout',
      message: 'MCP error -32001: Request timed out',
    });
  });

  it('lets a server that is slow to start finish, instead of killing it mid-warm', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReturnValue(
        new Promise((resolve) => setTimeout(resolve, MCP_STDIO_CONNECT_TIMEOUT_MS - 5_000)),
      );
      listToolsMock.mockResolvedValue({ tools: [sampleTool] });
      const pending = fetchMcpToolDescriptorsStdio({ command: 'docker', args: ['run', 'srv'] });
      await vi.advanceTimersByTimeAsync(MCP_STDIO_CONNECT_TIMEOUT_MS);
      expect(await pending).toEqual({ ok: true, tools: [sampleTool] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the operation its own window rather than whatever connect left over', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReturnValue(
        new Promise((resolve) => setTimeout(resolve, MCP_STDIO_CONNECT_TIMEOUT_MS - 1_000)),
      );
      listToolsMock.mockReturnValue(new Promise(() => {}));
      const pending = fetchMcpToolDescriptorsStdio({ command: 'npx' });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      // Past the connect guard, but only part-way into the operation's own guard.
      await vi.advanceTimersByTimeAsync(outerGuardMs(MCP_STDIO_CONNECT_TIMEOUT_MS));
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(outerGuardMs(MCP_OPERATION_TIMEOUT_MS));
      expect(await pending).toEqual({
        ok: false,
        reason: 'timeout',
        message: 'MCP fetch timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('failure capture', () => {
  it('captures a failure once per server and reason, not once per probe pass', async () => {
    connectMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await fetchMcpToolDescriptors('https://mcp.example', undefined, 'gitnexus');
    await fetchMcpToolDescriptors('https://mcp.example', undefined, 'gitnexus');
    expect(captureMainMessageMock).toHaveBeenCalledTimes(1);

    // A different server of the same kind is still its own signal.
    await fetchMcpToolDescriptors('https://mcp.example', undefined, 'context7');
    expect(captureMainMessageMock).toHaveBeenCalledTimes(2);
  });

  it('tags the config key so a failure is triageable', async () => {
    connectMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await fetchMcpToolDescriptors('https://mcp.example', undefined, 'gitnexus');
    expect(captureMainMessageMock).toHaveBeenCalledWith(
      expect.any(String),
      'warning',
      expect.objectContaining({ server: 'gitnexus', step: 'connect' }),
      expect.any(Array),
    );
  });

  it('never puts spawn args, env or headers in a capture — they carry live credentials', async () => {
    connectMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await fetchMcpToolDescriptorsStdio(
      {
        command: 'npx',
        args: ['-y', 'srv', 'API_KEY="super-secret-token"'],
        env: { TOKEN: 'env-secret-token' },
      },
      'magic',
    );
    const [message, , tags] = captureMainMessageMock.mock.calls[0];
    const serialized = `${message} ${JSON.stringify(tags)}`;
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('env-secret-token');
    expect(tags.server).toBe('magic');
  });
});

describe('failure attribution across the lifecycle', () => {
  it('attributes an operation failure to the operation step, timed from when it began', async () => {
    vi.useFakeTimers();
    try {
      const connectMs = MCP_STDIO_CONNECT_TIMEOUT_MS - 5_000;
      connectMock.mockReturnValue(new Promise((resolve) => setTimeout(resolve, connectMs)));
      listToolsMock.mockReturnValue(new Promise(() => {}));
      const pending = fetchMcpToolDescriptorsStdio({ command: 'npx' }, 'gitnexus');
      await vi.advanceTimersByTimeAsync(connectMs + outerGuardMs(MCP_OPERATION_TIMEOUT_MS));
      expect(await pending).toMatchObject({ reason: 'timeout' });

      const [, , tags] = captureMainMessageMock.mock.calls[0];
      expect(tags.step).toBe('operation');
      // Timed from the operation's own start, or the number cannot set the operation budget.
      expect(Number(tags.elapsed_ms)).toBeLessThan(connectMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the transport when the operation times out, not only on a connect failure', async () => {
    vi.useFakeTimers();
    try {
      listToolsMock.mockReturnValue(new Promise(() => {}));
      const pending = fetchMcpToolDescriptorsStdio({ command: 'npx' }, 'memory');
      await vi.advanceTimersByTimeAsync(outerGuardMs(MCP_OPERATION_TIMEOUT_MS));
      await pending;
      // A stdio child outlives an unclosed transport; a timeout must still reap it.
      expect(closeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports a second, different failure for a server already captured once', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await fetchMcpToolDescriptors('https://mcp.example', undefined, 'gitnexus');

    connectMock.mockRejectedValueOnce(
      new McpError(ErrorCode.RequestTimeout, 'Request timed out', {}),
    );
    await fetchMcpToolDescriptors('https://mcp.example', undefined, 'gitnexus');

    // Dedup bounds volume per failure CLASS, never hiding a shift between modes.
    expect(captureMainMessageMock).toHaveBeenCalledTimes(2);
    const reasons = captureMainMessageMock.mock.calls.map(([, , tags]) => tags.reason);
    expect(reasons.sort()).toEqual(['timeout', 'transport']);
  });
});

describe('tools/list pagination', () => {
  const toolA = { name: 'a', description: 'A', inputSchema: { type: 'object' as const } };
  const toolB = { name: 'b', description: 'B', inputSchema: { type: 'object' as const } };
  const paginationCaptures = () =>
    captureMainMessageMock.mock.calls.filter((call) =>
      String(call[0]).includes('pagination stopped early'),
    );

  it('follows nextCursor over HTTP and returns every page in order', async () => {
    listToolsMock
      .mockResolvedValueOnce({ tools: [toolA], nextCursor: 'c1' })
      .mockResolvedValueOnce({ tools: [toolB] });
    const result = await fetchMcpToolDescriptors('https://mcp.example');
    expect(listToolsMock).toHaveBeenNthCalledWith(1, undefined, {
      timeout: MCP_OPERATION_TIMEOUT_MS,
    });
    expect(listToolsMock).toHaveBeenNthCalledWith(
      2,
      { cursor: 'c1' },
      {
        timeout: MCP_OPERATION_TIMEOUT_MS,
      },
    );
    expect(result.ok && result.tools.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('follows nextCursor over stdio', async () => {
    listToolsMock
      .mockResolvedValueOnce({ tools: [toolA], nextCursor: 'c1' })
      .mockResolvedValueOnce({ tools: [toolB] });
    const result = await fetchMcpToolDescriptorsStdio({ command: 'npx' });
    expect(listToolsMock).toHaveBeenCalledTimes(2);
    expect(result.ok && result.tools.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('makes exactly one request for a single-page server', async () => {
    listToolsMock.mockResolvedValue({ tools: [toolA] });
    await fetchMcpToolDescriptors('https://mcp.example');
    expect(listToolsMock).toHaveBeenCalledTimes(1);
    expect(listToolsMock).toHaveBeenCalledWith(undefined, { timeout: MCP_OPERATION_TIMEOUT_MS });
  });

  it('treats an empty-string cursor as the last page', async () => {
    listToolsMock.mockResolvedValue({ tools: [toolA], nextCursor: '' });
    await fetchMcpToolDescriptors('https://mcp.example');
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it('gives each page its own budget rather than one total across pages', async () => {
    vi.useFakeTimers();
    try {
      const slowPage = (value: unknown) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(value), MCP_OPERATION_TIMEOUT_MS - 2_000),
        );
      listToolsMock
        .mockReturnValueOnce(slowPage({ tools: [toolA], nextCursor: 'c1' }))
        .mockImplementationOnce(() => slowPage({ tools: [toolB] }));
      const pending = fetchMcpToolDescriptors('https://mcp.example');
      await vi.advanceTimersByTimeAsync(2 * MCP_OPERATION_TIMEOUT_MS);
      const result = await pending;
      expect(result.ok && result.tools.map((t) => t.name)).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the whole probe when a later page fails — never a partial success', async () => {
    listToolsMock
      .mockResolvedValueOnce({ tools: [toolA], nextCursor: 'c1' })
      .mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
    const result = await fetchMcpToolDescriptors('https://mcp.example');
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('stops on a repeated cursor, returning what it has and capturing once', async () => {
    listToolsMock
      .mockResolvedValueOnce({ tools: [toolA], nextCursor: 'c1' })
      .mockResolvedValueOnce({ tools: [toolB], nextCursor: 'c1' });
    const result = await fetchMcpToolDescriptors('https://mcp.example', undefined, 'loopy');
    expect(listToolsMock).toHaveBeenCalledTimes(2);
    expect(result.ok && result.tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(paginationCaptures()).toHaveLength(1);
  });

  it('stops at the page bound and captures once per server across probes', async () => {
    let n = 0;
    listToolsMock.mockImplementation(async () => ({
      tools: [{ ...toolA, name: `t${n}` }],
      nextCursor: `c${++n}`,
    }));
    const result = await fetchMcpToolDescriptors('https://mcp.example', undefined, 'endless');
    expect(listToolsMock).toHaveBeenCalledTimes(MAX_TOOL_LIST_PAGES);
    expect(result.ok && result.tools).toHaveLength(MAX_TOOL_LIST_PAGES);
    await fetchMcpToolDescriptors('https://mcp.example', undefined, 'endless');
    expect(paginationCaptures()).toHaveLength(1);
  });

  it('keeps the first descriptor when a tool name repeats across pages', async () => {
    listToolsMock
      .mockResolvedValueOnce({ tools: [toolA], nextCursor: 'c1' })
      .mockResolvedValueOnce({ tools: [{ ...toolA, description: 'dupe' }, toolB] });
    const result = await fetchMcpToolDescriptors('https://mcp.example');
    expect(result.ok && result.tools.map((t) => [t.name, t.description])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
  });
});

describe('tools/list pagination edge cases', () => {
  const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } });
  const paginationCaptures = () =>
    captureMainMessageMock.mock.calls.filter((call) =>
      String(call[0]).includes('pagination stopped early'),
    );

  it('treats a last page landing exactly on the bound as complete, not truncated', async () => {
    for (let i = 1; i < MAX_TOOL_LIST_PAGES; i++) {
      listToolsMock.mockResolvedValueOnce({ tools: [tool(`t${i}`)], nextCursor: `c${i}` });
    }
    listToolsMock.mockResolvedValueOnce({ tools: [tool('last')] });
    const result = await fetchMcpToolDescriptors('https://mcp.example', undefined, 'exact');
    expect(listToolsMock).toHaveBeenCalledTimes(MAX_TOOL_LIST_PAGES);
    expect(result.ok && result.tools).toHaveLength(MAX_TOOL_LIST_PAGES);
    expect(captureMainMessageMock).not.toHaveBeenCalled();
  });

  it('detects a cursor cycle that is not back-to-back (c1 → c2 → c1)', async () => {
    listToolsMock
      .mockResolvedValueOnce({ tools: [tool('a')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ tools: [tool('b')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ tools: [tool('c')], nextCursor: 'c1' });
    const result = await fetchMcpToolDescriptors('https://mcp.example', undefined, 'cyclic');
    expect(listToolsMock).toHaveBeenCalledTimes(3);
    expect(result.ok && result.tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(paginationCaptures()).toHaveLength(1);
  });

  it('keeps paging past an empty intermediate page', async () => {
    listToolsMock
      .mockResolvedValueOnce({ tools: [], nextCursor: 'c1' })
      .mockResolvedValueOnce({ nextCursor: 'c2' })
      .mockResolvedValueOnce({ tools: [tool('late')] });
    const result = await fetchMcpToolDescriptors('https://mcp.example');
    expect(listToolsMock).toHaveBeenCalledTimes(3);
    expect(result.ok && result.tools.map((t) => t.name)).toEqual(['late']);
  });

  it('times out a hung later page on its own guard, timed from that page, and reaps the child', async () => {
    vi.useFakeTimers();
    try {
      const page1Ms = MCP_OPERATION_TIMEOUT_MS - 2_000;
      listToolsMock
        .mockReturnValueOnce(
          new Promise((resolve) =>
            setTimeout(() => resolve({ tools: [tool('a')], nextCursor: 'c1' }), page1Ms),
          ),
        )
        .mockReturnValueOnce(new Promise(() => {}));
      const pending = fetchMcpToolDescriptorsStdio({ command: 'npx' }, 'hangs');
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      // One guard window after the op began would kill a shared-total guard; per-page must not.
      await vi.advanceTimersByTimeAsync(outerGuardMs(MCP_OPERATION_TIMEOUT_MS));
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(page1Ms);
      expect(await pending).toEqual({ ok: false, reason: 'timeout', message: 'MCP fetch timeout' });
      expect(closeMock).toHaveBeenCalledTimes(1);
      const [, , tags] = captureMainMessageMock.mock.calls[0];
      expect(tags.step).toBe('operation');
      // Per-request clock: page 2's own wait, not page 1 + page 2.
      expect(Number(tags.elapsed_ms)).toBeLessThan(outerGuardMs(MCP_OPERATION_TIMEOUT_MS) + 1);
      expect(Number(tags.elapsed_ms)).toBeGreaterThanOrEqual(
        outerGuardMs(MCP_OPERATION_TIMEOUT_MS),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures a truncation once per server AND transport, never hiding a second server', async () => {
    const endless = () => {
      let n = 0;
      listToolsMock.mockImplementation(async () => ({ tools: [], nextCursor: `c${++n}` }));
    };
    endless();
    await fetchMcpToolDescriptors('https://a.example', undefined, 'server-a');
    endless();
    await fetchMcpToolDescriptors('https://b.example', undefined, 'server-b');
    endless();
    await fetchMcpToolDescriptorsStdio({ command: 'npx' }, 'server-a');
    endless();
    await fetchMcpToolDescriptors('https://a.example', undefined, 'server-a');
    const tags = paginationCaptures().map(([, , t]) => `${t.server}:${t.transport}`);
    expect(tags.sort()).toEqual(['server-a:http', 'server-a:stdio', 'server-b:http']);
  });

  it('never puts cursors or credential headers in a truncation capture', async () => {
    listToolsMock
      .mockResolvedValueOnce({ tools: [], nextCursor: 'opaque-cursor-secret' })
      .mockResolvedValueOnce({ tools: [], nextCursor: 'opaque-cursor-secret' });
    await fetchMcpToolDescriptors(
      'https://mcp.example',
      { Authorization: 'Bearer live-token' },
      'linear',
    );
    const serialized = JSON.stringify(paginationCaptures());
    expect(serialized).not.toContain('live-token');
    expect(serialized).not.toContain('opaque-cursor-secret');
    expect(paginationCaptures()[0][2]).toMatchObject({
      server: 'linear',
      reason: 'repeated_cursor',
    });
  });
});

describe('callMcpTool through the per-request runner', () => {
  it('still bounds a hung tool call with the outer guard and closes the transport', async () => {
    vi.useFakeTimers();
    try {
      callToolMock.mockReturnValue(new Promise(() => {}));
      const pending = callMcpToolStdio({ command: 'npx' }, 'slow_tool', {});
      await vi.advanceTimersByTimeAsync(outerGuardMs(MCP_CALL_TIMEOUT_MS));
      expect(await pending).toMatchObject({ ok: false, reason: 'timeout' });
      expect(closeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
