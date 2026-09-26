import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeMcpConfigTransport } from './mcp-config-transport';

describe('createClaudeMcpConfigTransport', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'frink-mcp-config-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(configDir, { recursive: true, force: true });
  });

  it('keeps stdio, HTTP, and OAuth credentials out of argv while staging a protected file', async () => {
    const transport = createClaudeMcpConfigTransport(
      {
        stdio: { command: 'npx', env: { API_KEY: 'stdio-secret' } },
        http: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer header-secret' },
          _oauth: {
            accessToken: 'oauth-access-secret',
            refreshToken: 'oauth-refresh-secret',
          },
        },
      },
      configDir,
      vi.fn(),
    );

    expect(transport).not.toBeNull();
    expect(JSON.stringify(transport?.extraArgs)).not.toMatch(
      /stdio-secret|header-secret|oauth-access-secret|oauth-refresh-secret/,
    );

    await transport?.stage();
    const serialized = await fs.promises.readFile(transport?.configPath ?? '', 'utf8');
    expect(serialized).toMatch(
      /stdio-secret|header-secret|oauth-access-secret|oauth-refresh-secret/,
    );
    if (process.platform !== 'win32') {
      expect((await fs.promises.stat(transport?.configPath ?? '')).mode & 0o777).toBe(0o600);
    }

    await transport?.clear();
    expect(fs.existsSync(transport?.configPath ?? '')).toBe(false);
  });

  it('re-stages the config for a fresh CLI retry', async () => {
    const transport = createClaudeMcpConfigTransport(
      { stdio: { command: 'npx', env: { API_KEY: 'retry-secret' } } },
      configDir,
      vi.fn(),
    );

    await transport?.stage();
    await transport?.clear();
    await transport?.stage();
    expect(await fs.promises.readFile(transport?.configPath ?? '', 'utf8')).toContain(
      'retry-secret',
    );
  });

  it('retains cleanup state so teardown can retry a transient removal failure', async () => {
    const onCleanupError = vi.fn();
    const transport = createClaudeMcpConfigTransport(
      { stdio: { command: 'npx' } },
      configDir,
      onCleanupError,
    );
    await transport?.stage();
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('busy'));

    await transport?.clear();
    expect(onCleanupError).toHaveBeenCalledOnce();
    expect(fs.existsSync(transport?.configPath ?? '')).toBe(true);

    await transport?.clear();
    expect(fs.existsSync(transport?.configPath ?? '')).toBe(false);
  });

  it('isolates overlapping executions so one cleanup cannot remove another config', async () => {
    const first = createClaudeMcpConfigTransport(
      { stdio: { command: 'first' } },
      configDir,
      vi.fn(),
    );
    const second = createClaudeMcpConfigTransport(
      { stdio: { command: 'second' } },
      configDir,
      vi.fn(),
    );

    expect(first?.configPath).not.toBe(second?.configPath);
    await Promise.all([first?.stage(), second?.stage()]);
    await first?.clear();

    expect(fs.existsSync(first?.configPath ?? '')).toBe(false);
    expect(await fs.promises.readFile(second?.configPath ?? '', 'utf8')).toContain('second');
  });

  it('does not create a transport when no MCP servers are enabled', () => {
    expect(createClaudeMcpConfigTransport({}, configDir, vi.fn())).toBeNull();
  });
});

describe('vendor-plugin servers reach the Claude transport', () => {
  // claude-code dedupes its plugin-minted copy against a manual server by exact URL (manual wins).
  it('writes managedBy vendor_plugin entries like any other canonical server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-mcp-transport-'));
    const transport = createClaudeMcpConfigTransport(
      { plugin_slack_slack: { type: 'http', url: 'https://x/mcp', managedBy: 'vendor_plugin' } },
      dir,
      () => {},
    );
    await transport?.stage();
    const written = JSON.parse(fs.readFileSync(transport?.configPath as string, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['plugin_slack_slack']);
    await transport?.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
