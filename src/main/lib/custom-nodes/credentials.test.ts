/**
 * Tests for custom node credential CRUD and env var resolution.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

const {
  mockNodeCredentials,
  insertRunMock,
  insertValuesMock,
  onConflictDoUpdateMock,
  updateRunMock,
  deleteRunMock,
  selectGetMock,
  selectAllMock,
} = vi.hoisted(() => {
  const mockNodeCredentials = {
    id: 'id',
    nodeName: 'node_name',
    credentialKey: 'credential_key',
    encryptedValue: 'encrypted_value',
  };
  const insertRunMock = vi.fn();
  const insertValuesMock = vi.fn((_row: unknown) => undefined);
  const onConflictDoUpdateMock = vi.fn((_opts: unknown) => ({ run: insertRunMock }));
  return {
    mockNodeCredentials,
    insertRunMock,
    insertValuesMock,
    onConflictDoUpdateMock,
    updateRunMock: vi.fn(),
    deleteRunMock: vi.fn(),
    selectGetMock: vi.fn(),
    selectAllMock: vi.fn(),
  };
});

const encryptTokenMock = vi.hoisted(() =>
  vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8').toString('base64')),
);
const decryptTokenMock = vi.hoisted(() =>
  vi.fn((encrypted: string) => {
    try {
      const buf = Buffer.from(encrypted, 'base64');
      const str = buf.toString('utf-8');
      return str.startsWith('enc:') ? str.slice(4) : null;
    } catch {
      return null;
    }
  }),
);

vi.mock('../credentials', () => ({
  encryptToken: (value: string) => encryptTokenMock(value),
  decryptToken: (encrypted: string) => decryptTokenMock(encrypted),
}));

vi.mock('../db', () => ({
  getDatabase: () => ({
    select: () => {
      const chain = {
        where: () => chain,
        get: selectGetMock,
        all: selectAllMock,
      };
      return { from: () => chain };
    },
    insert: () => ({
      values: (row: unknown) => {
        insertValuesMock(row);
        return {
          onConflictDoUpdate: (opts: unknown) => {
            onConflictDoUpdateMock(opts);
            return { run: insertRunMock };
          },
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({ run: updateRunMock }),
      }),
    }),
    delete: () => ({
      where: () => ({ run: deleteRunMock }),
    }),
  }),
  nodeCredentials: mockNodeCredentials,
}));

vi.mock('../db/utils', () => ({
  createId: () => 'test-id-001',
}));

vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ──

// Re-export shared helper (import would be hoisted above mocks, so dynamic import)
const { makeManifest } = await import('./test-helpers');

// ── Tests ──

describe('resolveCredentialEnvVar', () => {
  it('returns explicit envVar when provided', async () => {
    const { resolveCredentialEnvVar } = await import('./credentials');
    expect(resolveCredentialEnvVar('github', { envVar: 'GITHUB_TOKEN' })).toBe('GITHUB_TOKEN');
  });

  it('uppercases key when no envVar provided', async () => {
    const { resolveCredentialEnvVar } = await import('./credentials');
    expect(resolveCredentialEnvVar('slack_api', {})).toBe('SLACK_API');
  });

  it('uppercases key with hyphens', async () => {
    const { resolveCredentialEnvVar } = await import('./credentials');
    expect(resolveCredentialEnvVar('my-token', {})).toBe('MY-TOKEN');
  });
});

describe('getCredentialStatuses', () => {
  beforeEach(() => {
    selectAllMock.mockReset();
  });

  it('returns configured=true for keys with stored rows', async () => {
    selectAllMock.mockReturnValueOnce([
      { id: '1', nodeName: 'test-node', credentialKey: 'github', encryptedValue: 'enc' },
    ]);

    const { getCredentialStatuses } = await import('./credentials');
    const manifest = makeManifest({
      credentials: {
        github: { required: true, label: 'GitHub PAT' },
        slack: { label: 'Slack' },
      },
    });

    const statuses = getCredentialStatuses('test-node', manifest);
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toEqual({ key: 'github', label: 'GitHub PAT', configured: true });
    expect(statuses[1]).toEqual({ key: 'slack', label: 'Slack', configured: false });
  });

  it('uses key as label when label not in manifest', async () => {
    selectAllMock.mockReturnValueOnce([]);

    const { getCredentialStatuses } = await import('./credentials');
    const manifest = makeManifest({
      credentials: { api_key: {} },
    });

    const statuses = getCredentialStatuses('test-node', manifest);
    expect(statuses[0]?.label).toBe('api_key');
  });

  it('returns empty array when no credentials declared', async () => {
    selectAllMock.mockReturnValueOnce([]);

    const { getCredentialStatuses } = await import('./credentials');
    const manifest = makeManifest();

    expect(getCredentialStatuses('test-node', manifest)).toEqual([]);
  });
});

describe('setCredential', () => {
  beforeEach(() => {
    insertRunMock.mockReset();
    insertValuesMock.mockReset();
    onConflictDoUpdateMock.mockReset();
  });

  it('persists with a single atomic upsert (insert on conflict update)', async () => {
    const { setCredential } = await import('./credentials');
    const rawSecret = 'ghp_secret123';
    const expectedEncrypted = Buffer.from(`enc:${rawSecret}`, 'utf-8').toString('base64');

    setCredential('test-node', 'github', rawSecret);

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith({
      id: 'test-id-001',
      nodeName: 'test-node',
      credentialKey: 'github',
      encryptedValue: expectedEncrypted,
    });

    expect(onConflictDoUpdateMock).toHaveBeenCalledTimes(1);
    const upsertCall = onConflictDoUpdateMock.mock.calls[0];
    if (upsertCall === undefined || upsertCall[0] === undefined) {
      throw new Error('expected onConflictDoUpdate call with options');
    }
    const upsertOpts = upsertCall[0] as {
      target: unknown[];
      set: { encryptedValue: string };
    };
    expect(upsertOpts.target).toEqual([
      mockNodeCredentials.nodeName,
      mockNodeCredentials.credentialKey,
    ]);
    expect(upsertOpts.set).toEqual({ encryptedValue: expectedEncrypted });

    expect(insertRunMock).toHaveBeenCalledTimes(1);
  });
});

describe('clearCredential', () => {
  beforeEach(() => {
    deleteRunMock.mockReset();
  });

  it('deletes the matching credential row', async () => {
    const { clearCredential } = await import('./credentials');
    clearCredential('test-node', 'github');

    expect(deleteRunMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no matching row exists', async () => {
    const { clearCredential } = await import('./credentials');
    expect(() => clearCredential('nonexistent', 'key')).not.toThrow();
  });
});

describe('resolveNodeCredentialEnvVars', () => {
  beforeEach(() => {
    selectGetMock.mockReset();
  });

  it('resolves all credentials to env vars', async () => {
    const encValue = Buffer.from('enc:ghp_secret', 'utf-8').toString('base64');
    selectGetMock.mockReturnValueOnce({
      id: '1',
      nodeName: 'test-node',
      credentialKey: 'github',
      encryptedValue: encValue,
    });

    const { resolveNodeCredentialEnvVars } = await import('./credentials');
    const manifest = makeManifest({
      credentials: { github: { envVar: 'GITHUB_TOKEN', required: true } },
    });

    const result = resolveNodeCredentialEnvVars(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envVars.GITHUB_TOKEN).toBe('ghp_secret');
    }
  });

  it('returns ok with empty envVars when no credentials declared', async () => {
    const { resolveNodeCredentialEnvVars } = await import('./credentials');
    const manifest = makeManifest();

    const result = resolveNodeCredentialEnvVars(manifest);
    expect(result).toEqual({ ok: true, envVars: {} });
  });

  it('returns missing when required credential has no stored row', async () => {
    selectGetMock.mockReturnValueOnce(undefined);

    const { resolveNodeCredentialEnvVars } = await import('./credentials');
    const manifest = makeManifest({
      credentials: { github: { required: true, label: 'GitHub' } },
    });

    const result = resolveNodeCredentialEnvVars(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['github']);
    }
  });

  it('skips optional missing credentials without failing', async () => {
    selectGetMock.mockReturnValueOnce(undefined);

    const { resolveNodeCredentialEnvVars } = await import('./credentials');
    const manifest = makeManifest({
      credentials: { optional_key: { required: false } },
    });

    const result = resolveNodeCredentialEnvVars(manifest);
    expect(result).toEqual({ ok: true, envVars: {} });
  });

  it('treats decryption failure as missing for required credentials', async () => {
    selectGetMock.mockReturnValueOnce({
      id: '1',
      nodeName: 'test-node',
      credentialKey: 'github',
      encryptedValue: 'corrupted-not-base64',
    });

    const { resolveNodeCredentialEnvVars } = await import('./credentials');
    const manifest = makeManifest({
      credentials: { github: { required: true } },
    });

    const result = resolveNodeCredentialEnvVars(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['github']);
    }
  });

  it('uses key.toUpperCase() as default env var name', async () => {
    const encValue = Buffer.from('enc:secret123', 'utf-8').toString('base64');
    selectGetMock.mockReturnValueOnce({
      id: '1',
      nodeName: 'test-node',
      credentialKey: 'my_api',
      encryptedValue: encValue,
    });

    const { resolveNodeCredentialEnvVars } = await import('./credentials');
    const manifest = makeManifest({
      credentials: { my_api: { required: true } },
    });

    const result = resolveNodeCredentialEnvVars(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envVars.MY_API).toBe('secret123');
    }
  });

  it('collects all missing required keys', async () => {
    selectGetMock.mockReturnValue(undefined);

    const { resolveNodeCredentialEnvVars } = await import('./credentials');
    const manifest = makeManifest({
      credentials: {
        key_a: { required: true },
        key_b: { required: true },
        key_c: { required: false },
      },
    });

    const result = resolveNodeCredentialEnvVars(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['key_a', 'key_b']);
    }

    selectGetMock.mockReset();
  });

  it('last credential wins when envVar collides', async () => {
    const encA = Buffer.from('enc:secret-a', 'utf-8').toString('base64');
    const encB = Buffer.from('enc:secret-b', 'utf-8').toString('base64');

    selectGetMock
      .mockReturnValueOnce({
        id: '1',
        nodeName: 'test-node',
        credentialKey: 'cred_a',
        encryptedValue: encA,
      })
      .mockReturnValueOnce({
        id: '2',
        nodeName: 'test-node',
        credentialKey: 'cred_b',
        encryptedValue: encB,
      });

    const { resolveNodeCredentialEnvVars } = await import('./credentials');
    const manifest = makeManifest({
      credentials: {
        cred_a: { envVar: 'SAME_VAR', required: true },
        cred_b: { envVar: 'SAME_VAR', required: true },
      },
    });

    const result = resolveNodeCredentialEnvVars(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envVars.SAME_VAR).toBe('secret-b');
    }
  });
});
