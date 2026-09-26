import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrinkMcpConfig, FrinkMcpCredentialsFile, FrinkMcpServerConfig } from './types';

const { readFileMock, writeFileMock, encryptStringMock, decryptStringMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  encryptStringMock: vi.fn(),
  decryptStringMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: readFileMock, writeFile: writeFileMock };
});

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: encryptStringMock,
    decryptString: decryptStringMock,
  },
}));

vi.mock('../fs-helpers', () => ({
  ensureDirExists: vi.fn(),
  ensureDirExistsAsync: vi.fn().mockResolvedValue(undefined),
}));

import {
  _resetMcpConfigMutexForTests,
  _resetMcpCredentialsMutexForTests,
  FRINK_MCP_CONFIG_PATH,
  FRINK_MCP_CREDENTIALS_PATH,
  removeGlobalMcpServer,
  setGlobalMcpServer,
} from './config';

function makeServer(
  name: string,
  importedFrom?: FrinkMcpServerConfig['importedFrom'],
): FrinkMcpServerConfig {
  return {
    name,
    type: 'custom',
    authType: 'none',
    command: 'npx',
    importedFrom,
  };
}

function getWrittenConfig(): FrinkMcpConfig {
  const calls = writeFileMock.mock.calls;
  const last = [...calls].reverse().find((c) => c[0] === FRINK_MCP_CONFIG_PATH);
  if (!last) throw new Error('config.json was not written');
  return JSON.parse(last[1] as string) as FrinkMcpConfig;
}

beforeEach(() => {
  _resetMcpConfigMutexForTests();
  _resetMcpCredentialsMutexForTests();
  readFileMock.mockReset();
  writeFileMock.mockReset();
  encryptStringMock.mockReset();
  decryptStringMock.mockReset();

  encryptStringMock.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
  decryptStringMock.mockImplementation((b: Buffer) => b.toString().replace(/^enc:/, ''));
  writeFileMock.mockResolvedValue(undefined);
  readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('removeGlobalMcpServer (tombstone behavior)', () => {
  it('writes a tombstone when the removed server has importedFrom', async () => {
    const importedAt = '2026-04-26T00:00:00.000Z';
    const config: FrinkMcpConfig = {
      version: 2,
      servers: {
        github: makeServer('github', {
          source: 'claude-global',
          sourcePath: '/Users/me/.claude.json',
          importedAt,
        }),
      },
    };
    const credentials: FrinkMcpCredentialsFile = { servers: {} };

    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === FRINK_MCP_CONFIG_PATH) return JSON.stringify(config);
      if (fp === FRINK_MCP_CREDENTIALS_PATH)
        return Buffer.from(`enc:${JSON.stringify(credentials)}`).toString('base64');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await removeGlobalMcpServer('github');
    const written = getWrittenConfig();
    expect(written.servers.github).toBeUndefined();
    expect(written.deletedImports?.github).toMatchObject({
      source: 'claude-global',
      sourcePath: '/Users/me/.claude.json',
    });
  });

  it('does NOT write a tombstone for user-created servers (no importedFrom)', async () => {
    const config: FrinkMcpConfig = {
      version: 2,
      servers: { mine: makeServer('mine') },
    };
    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === FRINK_MCP_CONFIG_PATH) return JSON.stringify(config);
      if (fp === FRINK_MCP_CREDENTIALS_PATH)
        return Buffer.from(`enc:${JSON.stringify({ servers: {} })}`).toString('base64');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await removeGlobalMcpServer('mine');
    const written = getWrittenConfig();
    expect(written.deletedImports ?? {}).toEqual({});
  });
});

describe('setGlobalMcpServer (tombstone interaction)', () => {
  // Regression: if a user manually re-creates an MCP with a name that was
  // previously auto-imported and then deleted, the stale tombstone must be
  // cleared so the user's intent isn't ignored, and so the JSON doesn't
  // accumulate cruft as users churn imports.
  it('clears any matching tombstone when the user re-creates a server with that name', async () => {
    const config: FrinkMcpConfig = {
      version: 2,
      servers: {},
      deletedImports: {
        github: {
          source: 'claude-global',
          sourcePath: '/Users/me/.claude.json',
          deletedAt: '2026-04-26T00:00:00.000Z',
        },
      },
    };
    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === FRINK_MCP_CONFIG_PATH) return JSON.stringify(config);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await setGlobalMcpServer('github', makeServer('github'));
    const written = getWrittenConfig();
    expect(written.servers.github).toBeDefined();
    expect(written.deletedImports?.github).toBeUndefined();
  });

  // Regression: the tRPC `setGlobalServer` mutation validates input
  // through a Zod schema that does not include `importedFrom`. When a user
  // edits an auto-imported MCP through Settings, the input arrives without
  // provenance. If `setGlobalMcpServer` then does a full replacement, the
  // existing entry's `importedFrom` is wiped — so a later delete creates
  // no tombstone, and the importer happily resurrects the entry on next
  // boot. Solution: merge with the existing entry to preserve provenance.
  it('preserves importedFrom on the existing entry when the new server lacks it', async () => {
    const existingProvenance = {
      source: 'claude-global' as const,
      sourcePath: '/Users/me/.claude.json',
      importedAt: '2026-04-26T00:00:00.000Z',
    };
    const existingConfig: FrinkMcpConfig = {
      version: 2,
      servers: {
        github: makeServer('github', existingProvenance),
      },
    };
    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === FRINK_MCP_CONFIG_PATH) return JSON.stringify(existingConfig);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // User-edit shape: structural fields only, no `importedFrom`.
    await setGlobalMcpServer('github', {
      name: 'github',
      type: 'custom',
      authType: 'env_var',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });

    const written = getWrittenConfig();
    expect(
      (written.servers?.github as { importedFrom?: unknown } | undefined)?.importedFrom,
    ).toEqual(existingProvenance);
  });

  it('preserves managedBy on the existing entry when the new server lacks it (sc-851)', async () => {
    const existingConfig: FrinkMcpConfig = {
      version: 2,
      servers: {
        plugin_shortcut_shortcut: {
          ...makeServer('plugin_shortcut_shortcut'),
          managedBy: 'vendor_plugin',
        },
      },
    };
    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === FRINK_MCP_CONFIG_PATH) return JSON.stringify(existingConfig);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // User-edit shape: structural fields only, no `managedBy` (the Zod mutation strips it).
    await setGlobalMcpServer('plugin_shortcut_shortcut', {
      name: 'plugin_shortcut_shortcut',
      type: 'custom',
      authType: 'env_var',
      command: 'mcp-server-shortcut',
    });

    const written = getWrittenConfig();
    expect(
      (written.servers?.plugin_shortcut_shortcut as { managedBy?: unknown } | undefined)?.managedBy,
    ).toBe('vendor_plugin');
  });

  it('preserves complete managed identity metadata when a user edit omits it', async () => {
    const existingConfig: FrinkMcpConfig = {
      version: 2,
      servers: {
        plugin_shortcut_shortcut: {
          ...makeServer('plugin_shortcut_shortcut'),
          managedBy: 'vendor_plugin',
          managedPluginId: 'shortcut',
          managedConnectionId: 'int-1',
          managedCredentialsReady: true,
          managedCredentialGeneration: 'generation-1',
        },
      },
    };
    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === FRINK_MCP_CONFIG_PATH) return JSON.stringify(existingConfig);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await setGlobalMcpServer('plugin_shortcut_shortcut', {
      name: 'plugin_shortcut_shortcut',
      type: 'custom',
      authType: 'env_var',
      command: 'replacement-command',
    });

    expect(getWrittenConfig().servers.plugin_shortcut_shortcut).toEqual(
      expect.objectContaining({
        managedBy: 'vendor_plugin',
        managedPluginId: 'shortcut',
        managedConnectionId: 'int-1',
        managedCredentialsReady: true,
        managedCredentialGeneration: 'generation-1',
      }),
    );
  });

  it('does not touch tombstones for unrelated names', async () => {
    const config: FrinkMcpConfig = {
      version: 2,
      servers: {},
      deletedImports: {
        slack: {
          source: 'cursor-global',
          sourcePath: '/Users/me/.cursor/mcp.json',
          deletedAt: '2026-04-26T00:00:00.000Z',
        },
      },
    };
    readFileMock.mockImplementation(async (fp: string) => {
      if (fp === FRINK_MCP_CONFIG_PATH) return JSON.stringify(config);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await setGlobalMcpServer('github', makeServer('github'));
    const written = getWrittenConfig();
    expect(written.deletedImports?.slack).toBeDefined();
  });
});
