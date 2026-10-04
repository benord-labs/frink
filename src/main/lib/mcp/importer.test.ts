// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${VAR} fixtures simulate Cursor placeholder syntax under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  scanMock,
  invalidateCacheMock,
  isEncryptionAvailableMock,
  encryptStringMock,
  decryptStringMock,
  readFileMock,
  writeFileMock,
} = vi.hoisted(() => ({
  scanMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
  isEncryptionAvailableMock: vi.fn(),
  encryptStringMock: vi.fn(),
  decryptStringMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: isEncryptionAvailableMock,
    encryptString: encryptStringMock,
    decryptString: decryptStringMock,
  },
}));

vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: readFileMock, writeFile: writeFileMock };
});

vi.mock('./import-scanner', () => ({
  scanNativeMcpSources: scanMock,
}));

vi.mock('./claude-tools-cache', () => ({
  invalidateClaudeMcpToolsCache: invalidateCacheMock,
}));

import {
  _resetMcpConfigMutexForTests,
  _resetMcpCredentialsMutexForTests,
  setGlobalMcpServer,
  setMcpCredentials,
} from './config';
import type { ImportCandidate } from './import-scanner';
import { _resetMcpImporterForTests, candidateToFrinkConfig, runMcpImporter } from './importer';
import type { FrinkMcpServerConfig } from './types';

function claudeCandidate(name: string, overrides: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    name,
    source: 'claude-global',
    sourcePath: '/Users/me/.claude.json',
    config: { command: 'npx', args: ['-y', `@modelcontextprotocol/server-${name}`] },
    credentials: {},
    ...overrides,
  };
}

function getWrittenConfig(): {
  servers?: Record<string, unknown>;
  projects?: Record<string, unknown>;
  deletedImports?: Record<string, unknown>;
  version?: number;
} {
  // Last call to writeFile that targets the config path
  const calls = writeFileMock.mock.calls;
  const configCall = [...calls].reverse().find((c) => String(c[0]).endsWith('config.json'));
  if (!configCall) throw new Error('config.json was not written');
  return JSON.parse(configCall[1] as string);
}

function getWrittenCredentials(): { servers: Record<string, unknown> } {
  // credentials are encrypted via mock, so we can read the JSON we passed to encryptString
  const lastCredCall = [...encryptStringMock.mock.calls].pop();
  if (!lastCredCall) throw new Error('credentials were not encrypted');
  return JSON.parse(lastCredCall[0] as string);
}

beforeEach(() => {
  _resetMcpImporterForTests();
  _resetMcpConfigMutexForTests();
  _resetMcpCredentialsMutexForTests();
  scanMock.mockReset();
  invalidateCacheMock.mockReset();
  isEncryptionAvailableMock.mockReset();
  encryptStringMock.mockReset();
  decryptStringMock.mockReset();
  readFileMock.mockReset();
  writeFileMock.mockReset();

  // Sensible defaults
  isEncryptionAvailableMock.mockReturnValue(true);
  encryptStringMock.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
  decryptStringMock.mockImplementation((b: Buffer) => b.toString().replace(/^enc:/, ''));
  readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  writeFileMock.mockResolvedValue(undefined);
  scanMock.mockResolvedValue([]);

  delete process.env.GITHUB_TOKEN;
  delete process.env.SLACK_TOKEN;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runMcpImporter', () => {
  it('returns zero counts when there are no candidates', async () => {
    const result = await runMcpImporter();
    expect(result).toEqual({ imported: 0, conflicts: 0, backfilled: 0 });
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('imports a single-source candidate with credentials and importedFrom', async () => {
    scanMock.mockResolvedValue([
      claudeCandidate('github', {
        config: { command: 'npx', args: ['-y', 'gh'] },
        credentials: { env: { GITHUB_TOKEN: 'real-token' } },
      }),
    ]);

    const result = await runMcpImporter();
    expect(result).toEqual({ imported: 1, conflicts: 0, backfilled: 0 });

    const written = getWrittenConfig();
    expect(written.servers?.github).toMatchObject({
      name: 'github',
      command: 'npx',
      args: ['-y', 'gh'],
      authType: 'env_var',
      enabled: true,
      importedFrom: { source: 'claude-global', sourcePath: '/Users/me/.claude.json' },
    });

    const creds = getWrittenCredentials();
    expect(creds.servers.github).toEqual({ env: { GITHUB_TOKEN: 'real-token' } });
  });

  it('cross-source collision imports a structural shell with empty credentials', async () => {
    scanMock.mockResolvedValue([
      claudeCandidate('github', {
        credentials: { env: { GITHUB_TOKEN: 'claude-token' } },
      }),
      {
        name: 'github',
        source: 'cursor-global',
        sourcePath: '/Users/me/.cursor/mcp.json',
        config: { command: 'npx', args: ['gh-cursor'] },
        credentials: { env: { GITHUB_TOKEN: 'cursor-token' } },
      } as ImportCandidate,
    ]);

    const result = await runMcpImporter();
    expect(result).toEqual({ imported: 1, conflicts: 1, backfilled: 0 });

    const written = getWrittenConfig();
    expect(
      (written.servers?.github as { importedFrom: { source: string } }).importedFrom.source,
    ).toBe('claude-global');

    // No credentials should have been encrypted for github (collision path
    // skips the credential merge entirely).
    expect(encryptStringMock).not.toHaveBeenCalled();
  });

  it('skips a name that already exists as user-created (no importedFrom)', async () => {
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json')) {
        return JSON.stringify({
          version: 2,
          servers: {
            github: { name: 'github', type: 'custom', authType: 'none', command: 'mine' },
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    scanMock.mockResolvedValue([
      claudeCandidate('github', { credentials: { env: { GITHUB_TOKEN: 'native' } } }),
    ]);

    const result = await runMcpImporter();
    expect(result).toEqual({ imported: 0, conflicts: 0, backfilled: 0 });
    // The importer's mutex window always rewrites the config (idempotent
    // RMW); what matters is that the user's existing entry was preserved
    // and not replaced with the auto-import shell.
    const written = getWrittenConfig();
    expect((written.servers?.github as { command?: string } | undefined)?.command).toBe('mine');
    expect(
      (written.servers?.github as { importedFrom?: unknown } | undefined)?.importedFrom,
    ).toBeUndefined();
  });

  it('skips a name that was already imported (idempotent re-run)', async () => {
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json')) {
        return JSON.stringify({
          version: 2,
          servers: {
            github: {
              name: 'github',
              type: 'custom',
              authType: 'none',
              command: 'npx',
              importedFrom: {
                source: 'claude-global',
                sourcePath: '/Users/me/.claude.json',
                importedAt: '2026-01-01T00:00:00Z',
              },
            },
          },
          deletedImports: {},
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    scanMock.mockResolvedValue([claudeCandidate('github')]);

    const result = await runMcpImporter();
    expect(result).toEqual({ imported: 0, conflicts: 0, backfilled: 0 });
  });

  it('respects tombstones — never resurrects user-deleted imports', async () => {
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json')) {
        return JSON.stringify({
          version: 2,
          servers: {},
          deletedImports: {
            github: {
              source: 'claude-global',
              sourcePath: '/Users/me/.claude.json',
              deletedAt: '2026-04-01T00:00:00Z',
            },
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    scanMock.mockResolvedValue([claudeCandidate('github')]);

    const result = await runMcpImporter();
    expect(result).toEqual({ imported: 0, conflicts: 0, backfilled: 0 });
    // The mutex always rewrites; the invariant is that the imported entry
    // does NOT reappear and the tombstone is preserved.
    const written = getWrittenConfig();
    expect(written.servers?.github).toBeUndefined();
    expect(written.deletedImports?.github).toBeDefined();
  });

  it('per-project candidate appends name to config.projects[path].mcps', async () => {
    scanMock.mockResolvedValue([
      {
        name: 'fooSrv',
        source: 'cursor-project',
        sourcePath: '/repos/foo/.cursor/mcp.json',
        projectPath: '/repos/foo',
        config: { command: 'foo-cmd' },
        credentials: {},
      } as ImportCandidate,
    ]);

    const result = await runMcpImporter();
    expect(result).toEqual({ imported: 1, conflicts: 0, backfilled: 0 });

    const written = getWrittenConfig();
    expect((written.projects as { [k: string]: { mcps: string[] } })?.['/repos/foo']?.mcps).toEqual(
      ['fooSrv'],
    );
  });

  it('does not throw and imports structurally when safeStorage is unavailable', async () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    scanMock.mockResolvedValue([
      claudeCandidate('github', { credentials: { env: { GITHUB_TOKEN: 'real-token' } } }),
    ]);

    const result = await runMcpImporter();
    expect(result).toEqual({ imported: 1, conflicts: 0, backfilled: 0 });

    // structural config written, but credentials must NOT have been encrypted
    expect(encryptStringMock).not.toHaveBeenCalled();
    const written = getWrittenConfig();
    expect(written.servers?.github).toBeDefined();
  });

  it('resolves ${VAR} placeholders against process.env', async () => {
    process.env.GITHUB_TOKEN = 'env-resolved';
    scanMock.mockResolvedValue([
      claudeCandidate('github', {
        config: { command: 'npx', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
        credentials: { env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
      }),
    ]);

    await runMcpImporter();
    const creds = getWrittenCredentials();
    expect(creds.servers.github).toEqual({ env: { GITHUB_TOKEN: 'env-resolved' } });

    const written = getWrittenConfig();
    // resolved key must NOT appear in requiredEnvVars
    expect(
      (written.servers?.github as { requiredEnvVars?: string[] }).requiredEnvVars ?? [],
    ).not.toContain('GITHUB_TOKEN');
  });

  it('flags unresolved ${VAR} placeholders as requiredEnvVars (no credential leak)', async () => {
    // GITHUB_TOKEN intentionally unset
    scanMock.mockResolvedValue([
      claudeCandidate('github', {
        config: { command: 'npx', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
        credentials: { env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
      }),
    ]);

    await runMcpImporter();
    const written = getWrittenConfig();
    expect((written.servers?.github as { requiredEnvVars?: string[] }).requiredEnvVars).toContain(
      'GITHUB_TOKEN',
    );
    // No credentials encrypted for github (no creds to write)
    expect(encryptStringMock).not.toHaveBeenCalled();
  });

  it('coalesces concurrent triggers via the inflight mutex', async () => {
    let resolveScan: ((v: ImportCandidate[]) => void) | undefined;
    scanMock.mockImplementation(
      () =>
        new Promise<ImportCandidate[]>((resolve) => {
          resolveScan = resolve;
        }),
    );

    const a = runMcpImporter();
    const b = runMcpImporter();
    expect(scanMock).toHaveBeenCalledTimes(1);

    resolveScan?.([claudeCandidate('github')]);
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual(resB);
    expect(
      writeFileMock.mock.calls.filter((c) => String(c[0]).endsWith('config.json')),
    ).toHaveLength(1);
  });

  it('invalidates the claude tools cache after a successful import', async () => {
    scanMock.mockResolvedValue([claudeCandidate('github')]);
    await runMcpImporter();
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);
  });

  // Regression: in production the renderer can call `mcp.setGlobalServer`
  // (a tRPC mutation that goes through `setGlobalMcpServer`) at any moment
  // — including while the importer is mid-flight. Both routines do an
  // unsynchronised read-modify-write of the same JSON file. Without a
  // shared mutex, the importer's snapshot read happens BEFORE the user
  // mutation, the user mutation writes between, and the importer's later
  // write clobbers the user's entry. End state: user's manual add lost.
  // Companion to the config-mutex regression: the credentials file has its
  // own mutex covering `setMcpCredentials`, `removeMcpCredentials`, and the
  // importer's credentials write. A user typing into the Configure dialog
  // while the importer is mid-flight must not lose their input — and the
  // importer's credentials write must not lose the user's existing
  // credentials for unrelated MCPs.
  it('does not lose a concurrent setMcpCredentials write while the importer is running', async () => {
    let onDiskConfig: string | null = null;
    let onDiskCreds: string | null = null;
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json') && onDiskConfig) return onDiskConfig;
      if (String(fp).endsWith('credentials.json') && onDiskCreds) return onDiskCreds;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    let triggered = false;
    let setCredsPromise: Promise<void> | null = null;
    writeFileMock.mockImplementation(async (fp: string, contents: string) => {
      if (String(fp).endsWith('config.json')) {
        onDiskConfig = contents;
      } else if (String(fp).endsWith('credentials.json')) {
        // First credentials write is the importer's. Sneak a renderer-side
        // setMcpCredentials call in concurrently (NON-awaiting — awaiting
        // would deadlock against the credentials mutex).
        if (!triggered) {
          triggered = true;
          setCredsPromise = setMcpCredentials('user-srv', { env: { USER_TOKEN: 'real' } });
        }
        onDiskCreds = contents;
      }
    });

    scanMock.mockResolvedValue([
      claudeCandidate('github', { credentials: { env: { GITHUB_TOKEN: 'gh-token' } } }),
    ]);

    await runMcpImporter();
    if (setCredsPromise) await setCredsPromise;

    // Invert the mock encryption: base64 decode → strip 'enc:' prefix → parse.
    expect(onDiskCreds).not.toBeNull();
    const decoded = Buffer.from(onDiskCreds as unknown as string, 'base64').toString('utf-8');
    const finalCreds = JSON.parse(decoded.replace(/^enc:/, ''));
    expect(finalCreds.servers.github).toEqual({ env: { GITHUB_TOKEN: 'gh-token' } });
    expect(finalCreds.servers['user-srv']).toEqual({ env: { USER_TOKEN: 'real' } });
  });

  it('does not lose a concurrent setGlobalMcpServer write while the importer is running', async () => {
    // Single in-memory file: anything written here is what the next read
    // returns. Mirrors real disk semantics enough to expose the race.
    let onDisk: string | null = null;
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json') && onDisk) return onDisk;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    let triggered = false;
    let setGlobalPromise: Promise<void> | null = null;
    const userServer: FrinkMcpServerConfig = {
      name: 'manual',
      type: 'custom',
      authType: 'none',
      command: 'manual-cmd',
    };

    writeFileMock.mockImplementation(async (fp: string, contents: string) => {
      if (!String(fp).endsWith('config.json')) return;
      // Fire a concurrent renderer-side mutation while the importer's
      // mutex-guarded write is in progress. NON-awaiting — awaiting here
      // would deadlock against the shared mutex (the importer holds it
      // until this writeFile completes; setGlobalMcpServer would queue on
      // the same mutex).
      if (!triggered) {
        triggered = true;
        setGlobalPromise = setGlobalMcpServer('manual', userServer);
      }
      onDisk = contents;
    });

    scanMock.mockResolvedValue([claudeCandidate('github')]);

    await runMcpImporter();
    if (setGlobalPromise) await setGlobalPromise;

    expect(onDisk).not.toBeNull();
    const finalConfig = JSON.parse(onDisk as unknown as string);
    expect(finalConfig.servers.github).toBeDefined();
    expect(finalConfig.servers.manual).toBeDefined();
  });

  // Regression: if the existing encrypted credentials file is unreadable
  // (decrypt fails — corrupted file, transient keychain issue), the importer
  // MUST NOT treat that as "no existing credentials" and overwrite the file
  // with whatever we built in memory. Doing so would silently destroy the
  // user's previously-stored credentials. The safe behaviour is to abort
  // the run; the next boot can retry once the keychain recovers.
  it('aborts the run rather than overwriting an unreadable encrypted credentials file', async () => {
    // Existing on-disk encrypted file
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('credentials.json')) return 'corrupted-encrypted-blob';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    // Decrypt throws to simulate corruption / locked keychain
    decryptStringMock.mockImplementation(() => {
      throw new Error('decrypt failed');
    });

    scanMock.mockResolvedValue([
      claudeCandidate('github', { credentials: { env: { GITHUB_TOKEN: 'real-token' } } }),
    ]);

    await expect(runMcpImporter()).rejects.toThrow();
    // The encrypted file must NOT have been overwritten
    const credentialsWrites = writeFileMock.mock.calls.filter((c) =>
      String(c[0]).endsWith('credentials.json'),
    );
    expect(credentialsWrites).toHaveLength(0);
  });

  // Regression: if the credentials write fails (disk full, sandbox-revoked
  // keychain, etc.) AFTER the config write commits, the entry is left with
  // `importedFrom` set — next boot's idempotency check skips it forever, so
  // credentials never retry. Either credentials must be persisted FIRST,
  // or the config write must roll back when credentials fail. Either way,
  // a credentials-write failure must NOT leave an importedFrom-tagged config
  // entry sitting on disk without its credentials.
  it('does not leave importedFrom set on disk if credential persistence fails', async () => {
    scanMock.mockResolvedValue([
      claudeCandidate('github', { credentials: { env: { GITHUB_TOKEN: 'real-token' } } }),
    ]);

    // Fail any write that targets the credentials file (synchronously throw
    // during the encrypt step is also acceptable — exercise the encrypt path).
    encryptStringMock.mockImplementation(() => {
      throw new Error('keychain locked');
    });

    await expect(runMcpImporter()).rejects.toThrow();

    // Either no config write happened OR if it did, the github entry must
    // not be present (rolled back). Both are acceptable; the invariant is
    // that disk does not end up with the half-import.
    const configWrites = writeFileMock.mock.calls.filter((c) =>
      String(c[0]).endsWith('config.json'),
    );
    if (configWrites.length > 0) {
      const written = JSON.parse(configWrites[configWrites.length - 1][1] as string);
      expect(written.servers?.github).toBeUndefined();
    }
  });

  // Regression: pre-pipeline imports (added via the deprecated "Detected MCPs"
  // UI before the auto-import system shipped) live in `~/.frink/mcp/config.json`
  // without an `importedFrom` block. Without backfill they:
  //   1. Are invisible to the dedup filter — native rows keep showing in
  //      "Detected MCPs", so the user sees ghost duplicates forever.
  //   2. Are treated as "user-created" by the importer's idempotency check —
  //      so they never get cloud-synced or tombstoned on delete.
  // Backfill stamps `importedFrom` whenever a legacy entry structurally
  // matches a native candidate (same name + command + args + url).
  it('backfills importedFrom on a legacy global entry that matches a native candidate', async () => {
    const seeded = JSON.stringify({
      version: 2,
      servers: {
        github: {
          name: 'github',
          description: 'Imported from Claude Code',
          type: 'cloud_api',
          authType: 'bearer',
          command: '',
          args: [],
          url: 'https://api.githubcopilot.com/mcp/',
        },
      },
      deletedImports: {},
    });
    let onDiskConfig: string | null = seeded;
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json') && onDiskConfig) return onDiskConfig;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    writeFileMock.mockImplementation(async (fp: string, contents: string) => {
      if (String(fp).endsWith('config.json')) onDiskConfig = contents;
    });

    scanMock.mockResolvedValue([
      claudeCandidate('github', {
        config: {
          command: '',
          args: [],
          url: 'https://api.githubcopilot.com/mcp/',
        },
      }),
    ]);

    const result = await runMcpImporter();

    const written = getWrittenConfig();
    const stamped = (written.servers?.github as Record<string, unknown>)?.importedFrom as
      | { source?: string; sourcePath?: string; importedAt?: string }
      | undefined;
    expect(stamped?.source).toBe('claude-global');
    expect(stamped?.sourcePath).toBe('/Users/me/.claude.json');
    expect(stamped?.importedAt).toEqual(expect.any(String));
    // Backfill is reflected in the result counts so callers (telemetry,
    // toast UX) can distinguish backfilled-from-legacy vs net-new imports.
    expect(result.backfilled).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('does NOT backfill a legacy entry whose command/args do not match any candidate', async () => {
    // Same name as a native candidate, but the user customised the command.
    const seeded = JSON.stringify({
      version: 2,
      servers: {
        github: {
          name: 'github',
          type: 'custom',
          authType: 'none',
          command: '/usr/local/bin/my-custom-github-mcp',
          args: ['--special'],
        },
      },
    });
    let onDiskConfig: string | null = seeded;
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json') && onDiskConfig) return onDiskConfig;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    writeFileMock.mockImplementation(async (fp: string, contents: string) => {
      if (String(fp).endsWith('config.json')) onDiskConfig = contents;
    });

    scanMock.mockResolvedValue([
      claudeCandidate('github', {
        config: { command: 'npx', args: ['-y', 'gh'] },
      }),
    ]);

    await runMcpImporter();

    // No write happens because nothing changed (no backfill, nothing to import).
    const writes = writeFileMock.mock.calls.filter((c) => String(c[0]).endsWith('config.json'));
    if (writes.length > 0) {
      const written = JSON.parse(writes[writes.length - 1][1] as string);
      expect(written.servers?.github?.importedFrom).toBeUndefined();
    }
  });

  it('prefers claude-global over cursor sources when a legacy entry matches multiple', async () => {
    const seeded = JSON.stringify({
      version: 2,
      servers: {
        shortcut: {
          name: 'shortcut',
          type: 'custom',
          authType: 'env_var',
          command: 'mcp-server-shortcut',
          args: [],
        },
      },
    });
    let onDiskConfig: string | null = seeded;
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json') && onDiskConfig) return onDiskConfig;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    writeFileMock.mockImplementation(async (fp: string, contents: string) => {
      if (String(fp).endsWith('config.json')) onDiskConfig = contents;
    });

    scanMock.mockResolvedValue([
      {
        name: 'shortcut',
        source: 'cursor-project',
        sourcePath: '/Users/me/proj/.cursor/mcp.json',
        projectPath: '/Users/me/proj',
        config: { command: 'mcp-server-shortcut', args: [] },
        credentials: {},
      },
      {
        name: 'shortcut',
        source: 'claude-global',
        sourcePath: '/Users/me/.claude.json',
        config: { command: 'mcp-server-shortcut', args: [] },
        credentials: {},
      },
    ]);

    await runMcpImporter();

    const written = getWrittenConfig();
    const stamped = (written.servers?.shortcut as Record<string, unknown>)?.importedFrom as
      | { source?: string }
      | undefined;
    expect(stamped?.source).toBe('claude-global');
  });

  it('does not re-stamp an entry that already has importedFrom', async () => {
    const seeded = JSON.stringify({
      version: 2,
      servers: {
        github: {
          name: 'github',
          type: 'custom',
          authType: 'none',
          command: 'npx',
          args: ['-y', 'gh'],
          importedFrom: {
            source: 'cursor-global',
            sourcePath: '/Users/me/.cursor/mcp.json',
            importedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    });
    let onDiskConfig: string | null = seeded;
    readFileMock.mockImplementation(async (fp: string) => {
      if (String(fp).endsWith('config.json') && onDiskConfig) return onDiskConfig;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    writeFileMock.mockImplementation(async (fp: string, contents: string) => {
      if (String(fp).endsWith('config.json')) onDiskConfig = contents;
    });

    scanMock.mockResolvedValue([
      claudeCandidate('github', { config: { command: 'npx', args: ['-y', 'gh'] } }),
    ]);

    await runMcpImporter();

    const writes = writeFileMock.mock.calls.filter((c) => String(c[0]).endsWith('config.json'));
    if (writes.length > 0) {
      const written = JSON.parse(writes[writes.length - 1][1] as string);
      expect(written.servers?.github?.importedFrom?.source).toBe('cursor-global');
    }
  });
});

describe('candidateToFrinkConfig (auth type derivation)', () => {
  function freshCandidate(
    creds: ImportCandidate['credentials'],
    config: ImportCandidate['config'] = { command: 'npx' },
  ): ImportCandidate {
    return {
      name: 'srv',
      source: 'claude-global',
      sourcePath: '/Users/me/.claude.json',
      config,
      credentials: creds,
    };
  }

  it('OAuth tokens → oauth', () => {
    const { config } = candidateToFrinkConfig(freshCandidate({ oauth: { accessToken: 'tok' } }));
    expect(config.authType).toBe('oauth');
  });

  it('Bearer header → bearer', () => {
    const { config } = candidateToFrinkConfig(
      freshCandidate({ headers: { Authorization: 'Bearer xyz' } }),
    );
    expect(config.authType).toBe('bearer');
  });

  it('env vars only → env_var', () => {
    process.env.SLACK_TOKEN = 'real';
    const { config } = candidateToFrinkConfig(
      freshCandidate({ env: { SLACK_TOKEN: '${SLACK_TOKEN}' } }),
    );
    expect(config.authType).toBe('env_var');
  });

  it('no credentials → none', () => {
    const { config } = candidateToFrinkConfig(freshCandidate({}));
    expect(config.authType).toBe('none');
  });

  it('URL server → cloud_api type', () => {
    const { config } = candidateToFrinkConfig(
      freshCandidate({}, { url: 'https://example.com/mcp' }),
    );
    expect(config.type).toBe('cloud_api');
  });

  it('stdio server → custom type', () => {
    const { config } = candidateToFrinkConfig(freshCandidate({}, { command: 'npx' }));
    expect(config.type).toBe('custom');
  });

  // Kept verbatim because `candidateMatchesEntry` matches re-imports by exact
  // command/args; spawn sites normalize it (`spawn-shape.ts`).
  it('stores a Cursor whole-line command verbatim (split happens at spawn time)', () => {
    const { config } = candidateToFrinkConfig(
      freshCandidate({}, { command: 'npx -y @shortcut/mcp' }),
    );
    expect(config.command).toBe('npx -y @shortcut/mcp');
    expect(config.args).toBeUndefined();
  });
});
