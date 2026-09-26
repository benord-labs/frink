import { describe, expect, it, vi } from 'vitest';

// `migration-sweep.ts` only imports electron lazily for `app.getPath` (backups)
// and `safeStorage` (decryption). Both are exercised by the integration sweep
// (runCredentialMigrationSweep), not by `planSweep` (which takes the decrypt
// function as a parameter). Mock both so the import doesn't fail.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  app: { getPath: () => '/tmp' },
}));

vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

import { classifyDecryptedToken, planSweep } from './migration-sweep';

type Row = {
  id: string;
  type: string | null;
  account_label: string | null;
  oauth_token: string | null;
  source: string;
};

function row(overrides: Partial<Row> & Pick<Row, 'id'>): Row {
  return {
    type: 'claude-code',
    account_label: null,
    oauth_token: 'encrypted-bytes',
    source: 'api-key',
    ...overrides,
  };
}

const passthroughDecrypt = (token: string) => token;
const failingDecrypt = (_token: string) => null;

describe('classifyDecryptedToken', () => {
  // The classifier MUST default an unknown token shape to 'api-key': keeping a credential we
  // cannot classify is safer than deleting a working one.

  it('classifies sk-ant-oat01 as legacy OAuth snapshot (deletion target)', () => {
    expect(classifyDecryptedToken('sk-ant-oat01-AbCdEf123456')).toBe('legacy-oauth-snapshot');
  });

  it('classifies sk-ant-oat02 as legacy OAuth snapshot', () => {
    expect(classifyDecryptedToken('sk-ant-oat02-XYZ')).toBe('legacy-oauth-snapshot');
  });

  it('classifies leading whitespace before sk-ant-oat as legacy OAuth snapshot', () => {
    expect(classifyDecryptedToken('   sk-ant-oat01-token   ')).toBe('legacy-oauth-snapshot');
  });

  it('classifies legacy JSON envelope { claudeAiOauth: { accessToken } } as snapshot', () => {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-inner-token',
        refreshToken: 'rt',
        expiresAt: 1234567890000,
      },
    });
    expect(classifyDecryptedToken(json)).toBe('legacy-oauth-snapshot');
  });

  it('keeps sk-ant-api03 (Anthropic API key) as api-key', () => {
    expect(classifyDecryptedToken('sk-ant-api03-real-key-here')).toBe('api-key');
  });

  it('keeps sk-or-v1 (OpenRouter key) as api-key — must NOT be deleted', () => {
    expect(classifyDecryptedToken('sk-or-v1-abc123def456')).toBe('api-key');
  });

  it('keeps an opaque proxy key as api-key (default-keep)', () => {
    expect(classifyDecryptedToken('proxy-XYZ-987-secret-token')).toBe('api-key');
  });

  it('keeps garbage as api-key (default-keep — safer than deleting)', () => {
    expect(classifyDecryptedToken('lorem ipsum dolor sit')).toBe('api-key');
  });

  it('keeps empty-after-trim as api-key (no-op delete target)', () => {
    expect(classifyDecryptedToken('')).toBe('api-key');
    expect(classifyDecryptedToken('   ')).toBe('api-key');
  });

  it('keeps malformed JSON without claudeAiOauth as api-key', () => {
    expect(classifyDecryptedToken('{"foo":"bar"}')).toBe('api-key');
  });

  it('keeps JSON with claudeAiOauth but no accessToken as api-key', () => {
    expect(classifyDecryptedToken('{"claudeAiOauth":{"refreshToken":"rt"}}')).toBe('api-key');
  });

  it('keeps unparseable-but-leading-brace string as api-key', () => {
    expect(classifyDecryptedToken('{ this is not json ')).toBe('api-key');
  });

  it('keeps short Anthropic-prefix that is not oat or api as api-key', () => {
    // Hypothetical future Anthropic prefix we don't know yet — keep, don't destroy.
    expect(classifyDecryptedToken('sk-ant-future-shape-xyz')).toBe('api-key');
  });
});

describe('planSweep', () => {
  it('deletes a claude-code row whose token is a legacy OAuth snapshot', () => {
    const rows = [
      row({ id: 'claude-1', type: 'claude-code', oauth_token: 'sk-ant-oat01-snapshot' }),
    ];

    const plan = planSweep(rows, passthroughDecrypt);

    expect(plan.toDelete.map((r) => r.id)).toEqual(['claude-1']);
  });

  it('keeps a claude-code api-key row (sk-ant-api03)', () => {
    const rows = [row({ id: 'claude-2', type: 'claude-code', oauth_token: 'sk-ant-api03-real' })];

    const plan = planSweep(rows, passthroughDecrypt);

    expect(plan.toDelete).toHaveLength(0);
    expect(plan.toMarkApiKey).toHaveLength(0);
  });

  it('keeps an OpenRouter sk-or-v1 token (must NOT be misclassified as snapshot)', () => {
    const rows = [
      row({
        id: 'openrouter-1',
        type: 'claude-code',
        oauth_token: 'sk-or-v1-abc123def456',
      }),
    ];

    const plan = planSweep(rows, passthroughDecrypt);

    expect(plan.toDelete).toHaveLength(0);
  });

  it('skips github rows entirely (no delete, no source rewrite when already api-key)', () => {
    const rows = [
      row({
        id: 'gh-1',
        type: 'github',
        oauth_token: 'sk-ant-oat01-irrelevant',
        source: 'api-key',
      }),
    ];

    const plan = planSweep(rows, passthroughDecrypt);

    expect(plan.toDelete).toHaveLength(0);
    expect(plan.toMarkApiKey).toHaveLength(0);
  });

  it('keeps rows with NULL oauth_token (placeholder rows from cloud sync)', () => {
    const rows = [row({ id: 'placeholder-1', oauth_token: null })];

    const plan = planSweep(rows, passthroughDecrypt);

    expect(plan.toDelete).toHaveLength(0);
    expect(plan.toMarkApiKey).toHaveLength(0);
    expect(plan.rowsKeptOnDecryptError).toBe(0);
  });

  it('keeps rows that fail to decrypt (count tracked separately)', () => {
    const rows = [
      row({ id: 'corrupt-1', oauth_token: 'garbage-encrypted-bytes' }),
      row({ id: 'corrupt-2', oauth_token: 'more-garbage' }),
    ];

    const plan = planSweep(rows, failingDecrypt);

    expect(plan.toDelete).toHaveLength(0);
    expect(plan.toMarkApiKey).toHaveLength(0);
    expect(plan.rowsKeptOnDecryptError).toBe(2);
  });
});
