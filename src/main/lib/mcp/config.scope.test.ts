import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: readFileMock,
  };
});

vi.mock('../claude-config', () => ({
  GLOBAL_MCP_PATH: '__global__',
  resolveProjectPathFromWorktree: vi.fn((p: string) => (p === '/worktree' ? '/resolved' : null)),
}));

import { resolveProjectPathFromWorktree } from '../claude-config';
import {
  FRINK_MCP_CONFIG_PATH,
  getFrinkMcpServerConfigForScope,
  PROJECT_MCP_CONFIG_FILENAME,
} from './config';

function httpServer(name: string, url: string) {
  return {
    name,
    type: 'custom' as const,
    authType: 'oauth' as const,
    command: '',
    url,
  };
}

describe('getFrinkMcpServerConfigForScope', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    vi.mocked(resolveProjectPathFromWorktree).mockImplementation((p: string) =>
      p === '/worktree' ? '/resolved' : null,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns global Frink server for __global__ scope', async () => {
    readFileMock.mockImplementation(async (fp) => {
      if (fp === FRINK_MCP_CONFIG_PATH) {
        return JSON.stringify({
          version: 1,
          servers: { mysrv: httpServer('mysrv', 'https://g.example/mcp') },
        });
      }
      throw new Error('enoent');
    });
    await expect(getFrinkMcpServerConfigForScope('__global__', 'mysrv')).resolves.toEqual(
      expect.objectContaining({ url: 'https://g.example/mcp' }),
    );
  });

  it('returns undefined when global server name is missing', async () => {
    readFileMock.mockImplementation(async (fp) => {
      if (fp === FRINK_MCP_CONFIG_PATH) {
        return JSON.stringify({ version: 1, servers: {} });
      }
      throw new Error('enoent');
    });
    await expect(getFrinkMcpServerConfigForScope('__global__', 'none')).resolves.toBeUndefined();
  });

  it('prefers project .mcp.json over global Frink servers for the same name', async () => {
    const proj = '/Users/me/proj';
    readFileMock.mockImplementation(async (fp) => {
      const s = String(fp);
      if (s === FRINK_MCP_CONFIG_PATH) {
        return JSON.stringify({
          version: 1,
          servers: { dup: httpServer('dup', 'https://global-url/mcp') },
        });
      }
      if (s === path.join(proj, PROJECT_MCP_CONFIG_FILENAME)) {
        return JSON.stringify({
          servers: { dup: httpServer('dup', 'https://local-url/mcp') },
        });
      }
      throw new Error('enoent');
    });
    await expect(getFrinkMcpServerConfigForScope(proj, 'dup')).resolves.toEqual(
      expect.objectContaining({ url: 'https://local-url/mcp' }),
    );
  });

  it('merges Frink projects[].overrides URL onto global server', async () => {
    const proj = '/Users/me/proj';
    readFileMock.mockImplementation(async (fp) => {
      if (fp === FRINK_MCP_CONFIG_PATH) {
        return JSON.stringify({
          version: 1,
          servers: { s: httpServer('s', 'https://base.example/mcp') },
          projects: {
            [proj]: {
              mcps: ['s'],
              overrides: { s: { url: 'https://override.example/mcp' } },
            },
          },
        });
      }
      throw new Error('enoent');
    });
    const cfg = await getFrinkMcpServerConfigForScope(proj, 's');
    expect(cfg?.url).toBe('https://override.example/mcp');
  });

  it('checks resolved worktree path for project-local .mcp.json', async () => {
    readFileMock.mockImplementation(async (fp) => {
      const s = String(fp);
      if (s === FRINK_MCP_CONFIG_PATH) {
        return JSON.stringify({ version: 1, servers: {} });
      }
      if (s === path.join('/resolved', PROJECT_MCP_CONFIG_FILENAME)) {
        return JSON.stringify({
          servers: { w: httpServer('w', 'https://wt.example/mcp') },
        });
      }
      throw new Error('enoent');
    });
    const cfg = await getFrinkMcpServerConfigForScope('/worktree', 'w');
    expect(cfg?.url).toBe('https://wt.example/mcp');
  });

  it('falls back to global Frink server when project has no local or projects entry', async () => {
    const proj = '/Users/me/only-global';
    readFileMock.mockImplementation(async (fp) => {
      if (fp === FRINK_MCP_CONFIG_PATH) {
        return JSON.stringify({
          version: 1,
          servers: { g: httpServer('g', 'https://fallback.example/mcp') },
        });
      }
      throw new Error('enoent');
    });
    const cfg = await getFrinkMcpServerConfigForScope(proj, 'g');
    expect(cfg?.url).toBe('https://fallback.example/mcp');
  });
});
