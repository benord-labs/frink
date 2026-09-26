// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${VAR} fixtures simulate Cursor placeholder syntax under test.
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileMock, readClaudeConfigMock, listProjectsMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  readClaudeConfigMock: vi.fn(),
  listProjectsMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: readFileMock };
});

vi.mock('../claude-config', () => ({
  readClaudeConfig: readClaudeConfigMock,
}));

vi.mock('../db', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../db/repos/projects', () => ({
  listProjects: listProjectsMock,
}));

import { scanNativeMcpSources } from './import-scanner';
import { frinkUserHome } from '../platform/frink-home';

const HOME = frinkUserHome();
const CLAUDE_PATH = path.join(HOME, '.claude.json');
const CURSOR_GLOBAL_PATH = path.join(HOME, '.cursor', 'mcp.json');

beforeEach(() => {
  readFileMock.mockReset();
  readClaudeConfigMock.mockReset();
  listProjectsMock.mockReset();

  // Defaults: no native files
  readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  readClaudeConfigMock.mockResolvedValue({});
  listProjectsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('scanNativeMcpSources', () => {
  it('emits candidates from ~/.claude.json global mcpServers', async () => {
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        sentry: { url: 'https://sentry.example/mcp', _oauth: { accessToken: 'tok' } },
      },
    });

    const candidates = await scanNativeMcpSources();
    expect(candidates).toHaveLength(2);

    const github = candidates.find((c) => c.name === 'github');
    expect(github).toMatchObject({
      source: 'claude-global',
      sourcePath: CLAUDE_PATH,
      config: { command: 'npx' },
    });

    const sentry = candidates.find((c) => c.name === 'sentry');
    expect(sentry?.credentials.oauth?.accessToken).toBe('tok');
  });

  it('emits candidates from ~/.cursor/mcp.json global mcpServers', async () => {
    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === CURSOR_GLOBAL_PATH) {
        return JSON.stringify({
          mcpServers: {
            slack: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-slack'],
              env: { SLACK_TOKEN: '${SLACK_TOKEN}' },
            },
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const candidates = await scanNativeMcpSources();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: 'slack',
      source: 'cursor-global',
      sourcePath: CURSOR_GLOBAL_PATH,
    });
    expect(candidates[0].credentials.env).toEqual({ SLACK_TOKEN: '${SLACK_TOKEN}' });
  });

  it('emits per-project Cursor candidates for every registered project', async () => {
    listProjectsMock.mockResolvedValue([
      { id: 'p1', path: '/repos/foo' },
      { id: 'p2', path: '/repos/bar' },
    ]);

    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === path.join('/repos/foo', '.cursor', 'mcp.json')) {
        return JSON.stringify({
          mcpServers: { fooSrv: { command: 'foo-cmd' } },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const candidates = await scanNativeMcpSources();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: 'fooSrv',
      source: 'cursor-project',
      projectPath: '/repos/foo',
      sourcePath: path.join('/repos/foo', '.cursor', 'mcp.json'),
    });
  });

  it("filters out Frink's own injected frink_dynamic_chat entry from Cursor", async () => {
    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === CURSOR_GLOBAL_PATH) {
        return JSON.stringify({
          mcpServers: {
            frink_dynamic_chat: { url: 'http://localhost:31415/mcp' },
            slack: { command: 'npx' },
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const candidates = await scanNativeMcpSources();
    const names = candidates.map((c) => c.name);
    expect(names).toContain('slack');
    expect(names).not.toContain('frink_dynamic_chat');
  });

  // Regression: a `frink` entry in ~/.claude.json points at Frink's own MCP.
  // Importing it would loop Frink-into-Frink — must be filtered.
  it("filters out Frink's own injected `frink` entry from ~/.claude.json", async () => {
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: {
        frink: { command: 'node', args: ['/path/to/cli.js', 'mcp'] },
        github: { command: 'npx' },
      },
    });

    const candidates = await scanNativeMcpSources();
    const names = candidates.map((c) => c.name);
    expect(names).toContain('github');
    expect(names).not.toContain('frink');
  });

  it('extracts headers and OAuth credentials into normalized shape', async () => {
    readClaudeConfigMock.mockResolvedValue({
      mcpServers: {
        bearerSrv: {
          url: 'https://api.example/mcp',
          headers: { Authorization: 'Bearer abc123' },
        },
        oauthSrv: {
          url: 'https://oauth.example/mcp',
          _oauth: {
            accessToken: 'access',
            refreshToken: 'refresh',
            clientId: 'client',
            expiresAt: 12345,
          },
        },
      },
    });

    const candidates = await scanNativeMcpSources();
    const bearer = candidates.find((c) => c.name === 'bearerSrv');
    expect(bearer?.credentials.headers).toEqual({ Authorization: 'Bearer abc123' });

    const oauth = candidates.find((c) => c.name === 'oauthSrv');
    expect(oauth?.credentials.oauth).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      clientId: 'client',
      expiresAt: 12345,
    });
  });

  it('returns empty array when no native sources exist', async () => {
    const candidates = await scanNativeMcpSources();
    expect(candidates).toEqual([]);
  });
});
