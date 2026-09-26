import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSessionsForTest,
  claimRetainedSession,
  createSession,
  retainSession,
} from './socket/claude-session-registry';
import { computeClaudeSessionKey } from './socket/execution/claude-session/session-key';

const runMock = vi.fn(() => ({ changes: 1 }));
const setSpy = vi.fn();

const getMock = vi.fn();
const allMock = vi.fn();
const orderBySpy = vi.fn();
const probeClaudePassthroughSourceMock = vi.fn();
const probeCodexPassthroughSourceMock = vi.fn();

vi.mock('./credentials/source-readers', () => ({
  probeClaudePassthroughSource: probeClaudePassthroughSourceMock,
  probeCodexPassthroughSource: probeCodexPassthroughSourceMock,
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}));

vi.mock('./db', () => ({
  getDatabase: () => ({
    update: () => ({
      set: (patch: unknown) => {
        setSpy(patch);
        return {
          where: () => ({
            run: runMock,
          }),
        };
      },
    }),
    select: () => {
      const queryChain = {
        where: () => queryChain,
        orderBy: (...args: unknown[]) => {
          orderBySpy(...args);
          return queryChain;
        },
        limit: () => queryChain,
        get: getMock,
        all: allMock,
      };
      return {
        from: () => queryChain,
      };
    },
  }),
  claudeCodeCredentials: {
    cloudAccountId: {},
    source: 'source-col',
    needsReauthAt: 'needs-reauth-at-col',
    oauthToken: 'oauth-token-col',
    connectedAt: 'connected-at-col',
  },
}));

describe('clearClaudeCodeTokenByLabel', () => {
  beforeEach(() => {
    runMock.mockClear();
    getMock.mockReset();
  });

  it('clears oauthToken for an api-key row', async () => {
    // The implementation now does a SELECT first to learn the row's `source` so
    // it can branch (api-key → null oauth_token; passthrough → set needsReauthAt).
    getMock.mockReturnValueOnce({ id: 'row-1', source: 'api-key' });
    const { clearClaudeCodeTokenByLabel } = await import('./credentials');
    clearClaudeCodeTokenByLabel('personal');
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('sets needsReauthAt for a passthrough row instead of clearing token', async () => {
    getMock.mockReturnValueOnce({ id: 'row-2', source: 'claude-passthrough' });
    const { clearClaudeCodeTokenByLabel } = await import('./credentials');
    clearClaudeCodeTokenByLabel('claude');
    // The write is serialized behind the row lock, so it lands a tick later.
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ needsReauthAt: expect.any(Date) }),
    );
  });

  it('does not throw when db update runs', async () => {
    getMock.mockReturnValueOnce({ id: 'row-3', source: 'api-key' });
    const { clearClaudeCodeTokenByLabel } = await import('./credentials');
    expect(() => clearClaudeCodeTokenByLabel('work')).not.toThrow();
  });
});

describe('encryptToken — safeStorage availability gate', () => {
  it('throws CredentialEncryptionUnavailableError when the OS keyring is missing', async () => {
    // The top-of-file electron mock returns `isEncryptionAvailable: () => false`.
    // Pre-fix: encryptToken silently returned base64 plaintext, leaving API
    // keys at-rest in cleartext on headless Linux. Post-fix: it throws so the
    // tRPC mutation surfaces a user-facing error and we never write plaintext.
    const { encryptToken, CredentialEncryptionUnavailableError } = await import('./credentials');
    expect(() => encryptToken('sk-ant-secret-key')).toThrow(CredentialEncryptionUnavailableError);
  });
});

describe('getDescriptionCredentialAttempts', () => {
  beforeEach(() => {
    getMock.mockClear();
    allMock.mockClear();
  });

  it('returns default account first, then fallback accounts', async () => {
    getMock.mockReturnValueOnce({
      id: 'default-id',
      oauthToken: Buffer.from('default-token').toString('base64'),
      accountLabel: 'Default Account',
      type: 'claude-code',
    });
    allMock.mockReturnValueOnce([
      {
        id: 'default-id',
        oauthToken: Buffer.from('default-token').toString('base64'),
        accountLabel: 'Default Account',
        type: 'claude-code',
      },
      {
        id: 'claude-id',
        oauthToken: Buffer.from('claude-token').toString('base64'),
        accountLabel: 'Claude',
        type: 'claude-code',
      },
    ]);

    const { getDescriptionCredentialAttempts } = await import('./credentials');
    await expect(getDescriptionCredentialAttempts()).resolves.toMatchObject([
      { token: 'default-token', label: 'Default Account', type: 'claude-code' },
      { token: 'claude-token', label: 'Claude', type: 'claude-code' },
    ]);
  });

  it('caps attempts at three active credentials', async () => {
    getMock.mockReturnValueOnce(undefined);
    allMock.mockReturnValueOnce([
      {
        id: 'a',
        oauthToken: Buffer.from('token-a').toString('base64'),
        accountLabel: 'A',
        type: 'claude-code',
      },
      {
        id: 'b',
        oauthToken: Buffer.from('token-b').toString('base64'),
        accountLabel: 'B',
        type: 'claude-code',
      },
      {
        id: 'c',
        oauthToken: Buffer.from('token-c').toString('base64'),
        accountLabel: 'C',
        type: 'claude-code',
      },
      {
        id: 'd',
        oauthToken: Buffer.from('token-d').toString('base64'),
        accountLabel: 'D',
        type: 'claude-code',
      },
    ]);

    const { getDescriptionCredentialAttempts } = await import('./credentials');
    const attempts = await getDescriptionCredentialAttempts();
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.token)).toEqual(['token-a', 'token-b', 'token-c']);
  });

  it('returns empty attempts when no user is authenticated', async () => {
    const { getDescriptionCredentialAttempts } = await import('./credentials');
    await expect(getDescriptionCredentialAttempts()).resolves.toEqual([]);
  });
});

describe('user-scoped credential guards', () => {
  beforeEach(() => {
    getMock.mockClear();
    allMock.mockClear();
  });

  it('returns null token when default credential requested without authenticated user', async () => {
    const { getDefaultClaudeCodeToken } = await import('./credentials');
    await expect(getDefaultClaudeCodeToken()).resolves.toMatchObject({
      token: null,
      label: null,
      type: 'claude-code',
    });
  });

  it('returns null token when a credential is requested by id without an authenticated user', async () => {
    const { getClaudeCodeTokenById } = await import('./credentials');
    await expect(getClaudeCodeTokenById('cred-work')).resolves.toMatchObject({
      token: null,
      label: null,
      type: 'claude-code',
    });
  });
});

describe('codex-passthrough resolution', () => {
  // Presence-only probe like claude; the codex identity lives inside the secret, so no email adoption.
  const codexRow = {
    id: 'codex-1',
    type: 'codex',
    oauthToken: null,
    accountLabel: 'My Codex',
    source: 'codex-passthrough',
    sourcePath: 'codex-passthrough://local',
    expectedEmail: 'connect@example.com',
    needsReauthAt: null,
  };

  beforeEach(() => {
    setSpy.mockClear();
    getMock.mockReset();
    probeCodexPassthroughSourceMock.mockReset();
    probeCodexPassthroughSourceMock.mockResolvedValue({ ok: true });
  });

  it('resolves a default codex row to a token-null codex credential, keeping its email', async () => {
    getMock.mockReturnValueOnce(codexRow);
    const { getDefaultClaudeCodeToken } = await import('./credentials');
    await expect(getDefaultClaudeCodeToken()).resolves.toEqual({
      token: null,
      label: 'My Codex',
      isApiKey: false,
      type: 'codex',
      passthrough: true,
    });
    expect(setSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ expectedEmail: expect.anything() }),
    );
  });

  it('flags the row when the codex login is gone and heals it once it is back', async () => {
    getMock.mockReturnValueOnce(codexRow);
    probeCodexPassthroughSourceMock.mockResolvedValueOnce({ error: 'missing' });
    const { getClaudeCodeTokenById, isResolvedCredential } = await import('./credentials');
    expect(isResolvedCredential(await getClaudeCodeTokenById('codex-1'))).toBe(false);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ needsReauthAt: expect.any(Date) }),
    );

    getMock.mockReturnValueOnce({ ...codexRow, needsReauthAt: new Date('2026-01-01') });
    expect(isResolvedCredential(await getClaudeCodeTokenById('codex-1'))).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ needsReauthAt: null }));
  });
});

describe('isResolvedCredential — execution-gate predicate', () => {
  // Shared by both pre-flight gates (chat + Flow tasks) so they can't drift on what counts
  // as authenticated. Passthrough rows are token-null by design — the provider binary reads
  // its own credential store — so `passthrough`, not token presence, is the gate.
  it('treats a token-bearing credential as resolved', async () => {
    const { isResolvedCredential } = await import('./credentials');
    expect(isResolvedCredential({ token: 'sk-ant-oat-x' })).toBe(true);
  });

  it('treats a token-null passthrough credential as resolved', async () => {
    const { isResolvedCredential } = await import('./credentials');
    expect(isResolvedCredential({ token: null, passthrough: true })).toBe(true);
  });

  it('treats a token-null non-passthrough credential as unresolved', async () => {
    const { isResolvedCredential } = await import('./credentials');
    expect(isResolvedCredential({ token: null })).toBe(false);
  });
});

describe('claude-passthrough resolution — probe presence, never read the token', () => {
  const passthroughRow = {
    id: 'pt-1',
    accountLabel: 'Claude Code',
    type: 'claude-code',
    oauthToken: null,
    source: 'claude-passthrough',
    sourcePath: 'file:///tmp/claude-credentials.json',
    expectedEmail: null,
    needsReauthAt: null,
  };

  beforeEach(async () => {
    runMock.mockClear();
    setSpy.mockClear();
    getMock.mockReset();
    probeClaudePassthroughSourceMock.mockReset();
    __resetSessionsForTest();
    const { passthroughDeps } = await import('./credentials');
    passthroughDeps.readLiveLogin = () => ({});
  });

  it('resolves token-null + passthrough when the source exists', async () => {
    getMock.mockReturnValueOnce(passthroughRow);
    probeClaudePassthroughSourceMock.mockResolvedValue({ ok: true });

    const { getClaudeCodeTokenById, isResolvedCredential } = await import('./credentials');
    const result = await getClaudeCodeTokenById('passthrough-1');

    // A null token here is success, not failure: the spawned CLI reads the keychain itself.
    // Injecting a token is what froze the credential and 401'd every in-flight agent on rotation.
    expect(result.token).toBeNull();
    expect(result.passthrough).toBe(true);
    expect(result.isApiKey).toBe(false);
    expect(isResolvedCredential(result)).toBe(true);
  });

  it('marks needs-reauth and resolves unusable when the source is gone', async () => {
    getMock.mockReturnValueOnce(passthroughRow);
    probeClaudePassthroughSourceMock.mockResolvedValue({ error: 'missing' });

    const { getClaudeCodeTokenById, isResolvedCredential } = await import('./credentials');
    const result = await getClaudeCodeTokenById('passthrough-1');

    expect(isResolvedCredential(result)).toBe(false);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ needsReauthAt: expect.any(Date) }),
    );
  });

  // The flag is a derived cache, not a verdict: a flagged row re-probes every resolution
  // and heals itself the moment the login is back — no reauth button, no user action.
  it('self-heals a flagged row once the source probe succeeds again', async () => {
    getMock.mockReturnValueOnce({ ...passthroughRow, needsReauthAt: new Date('2026-01-01') });
    probeClaudePassthroughSourceMock.mockResolvedValue({ ok: true });

    const { getClaudeCodeTokenById, isResolvedCredential } = await import('./credentials');
    const result = await getClaudeCodeTokenById('passthrough-1');

    expect(isResolvedCredential(result)).toBe(true);
    expect(result.passthrough).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ needsReauthAt: null }));
  });

  // The machine's live login changed (e.g. an external account switcher): adopt the new
  // identity instead of demanding a reauth. The label is the user's chosen name — untouched.
  it('adopts the live login on identity drift without touching the label', async () => {
    getMock.mockReturnValueOnce({ ...passthroughRow, expectedEmail: 'old@example.com' });
    probeClaudePassthroughSourceMock.mockResolvedValue({ ok: true });
    const { getClaudeCodeTokenById, isResolvedCredential, passthroughDeps } =
      await import('./credentials');
    passthroughDeps.readLiveLogin = () => ({ email: 'new@example.com' });
    const result = await getClaudeCodeTokenById('passthrough-1');

    expect(isResolvedCredential(result)).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEmail: 'new@example.com', needsReauthAt: null }),
    );
    expect(setSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountLabel: expect.anything() }),
    );
  });

  it.each([
    [
      'retires idle Claude sessions when it adopts a changed live login',
      'old@example.com',
      'new@example.com',
      1,
    ],
    ['keeps them when the live login reads as no email', 'old@example.com', null, 0],
    ['retires them when a known email follows a read with none', null, 'new@example.com', 1],
  ])('%s', async (_, expectedEmail, liveEmail, closes) => {
    const close = vi.fn();
    const next = () => new Promise(() => {});
    retainSession(createSession('idle-sub', () => ({ close, next }) as unknown as Query));
    getMock.mockReturnValueOnce({ ...passthroughRow, expectedEmail });
    probeClaudePassthroughSourceMock.mockResolvedValue({ ok: true });
    const { getClaudeCodeTokenById, passthroughDeps } = await import('./credentials');
    passthroughDeps.readLiveLogin = () => ({ email: liveEmail ?? undefined });
    await getClaudeCodeTokenById('passthrough-1');

    expect(close).toHaveBeenCalledTimes(closes);
  });

  // The email is unchanged, so no sweep runs: the login key part retires the previous CLI.
  it('misses the claim of an idle session after a switch to another organization', async () => {
    probeClaudePassthroughSourceMock.mockResolvedValue({ ok: true });
    const { getClaudeCodeTokenById, passthroughDeps } = await import('./credentials');
    const keyPartsIn = async (organizationUuid: string) => {
      getMock.mockReturnValueOnce({ ...passthroughRow, expectedEmail: 'me@example.com' });
      passthroughDeps.readLiveLogin = () => ({ email: 'me@example.com', organizationUuid });
      return computeClaudeSessionKey({}, {}, (await getClaudeCodeTokenById('pt-1')).login);
    };
    const close = vi.fn();
    const next = () => new Promise(() => {});
    const spec = { keyParts: await keyPartsIn('org-personal'), sdkSessionId: 's1' };
    retainSession(createSession('idle-sub', () => ({ close, next }) as unknown as Query, spec));
    const request = { keyParts: await keyPartsIn('org-team'), persistedSessionId: 's1' };

    expect(claimRetainedSession('idle-sub', { ...request, flowTurn: false })).toEqual({
      miss: 'key-mismatch:login',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['retires idle Claude sessions when a resolution first finds the login signed out', 1, 1],
    ['keeps them when an already-flagged login is still signed out', 0, 0],
  ])('%s', async (_, changes, closes) => {
    const close = vi.fn();
    const next = () => new Promise(() => {});
    retainSession(createSession('idle-sub', () => ({ close, next }) as unknown as Query));
    runMock.mockReturnValueOnce({ changes }); // the conditional flag write
    getMock.mockReturnValueOnce(passthroughRow);
    probeClaudePassthroughSourceMock.mockResolvedValue({ error: 'missing' });
    const { getClaudeCodeTokenById } = await import('./credentials');
    await getClaudeCodeTokenById('passthrough-1');

    expect(close).toHaveBeenCalledTimes(closes);
  });

  it('clears the stored email when the live login carries none', async () => {
    getMock.mockReturnValueOnce({ ...passthroughRow, expectedEmail: 'old@example.com' });
    probeClaudePassthroughSourceMock.mockResolvedValue({ ok: true });
    const { getClaudeCodeTokenById } = await import('./credentials');
    await getClaudeCodeTokenById('passthrough-1');
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ expectedEmail: null }));
  });

  // A locked keychain / TCC prompt / probe timeout is transient — persisting it would
  // strand the row dead after e.g. a screen-saver unlock. Nothing is written; the next
  // resolution recovers on its own.
  it('persists nothing on a denied probe and recovers on the next resolution', async () => {
    getMock.mockReturnValueOnce(passthroughRow);
    probeClaudePassthroughSourceMock.mockResolvedValueOnce({ error: 'denied' });

    const { getClaudeCodeTokenById, isResolvedCredential } = await import('./credentials');
    const denied = await getClaudeCodeTokenById('passthrough-1');
    expect(isResolvedCredential(denied)).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();

    getMock.mockReturnValueOnce(passthroughRow);
    probeClaudePassthroughSourceMock.mockResolvedValueOnce({ ok: true });
    const recovered = await getClaudeCodeTokenById('passthrough-1');
    expect(isResolvedCredential(recovered)).toBe(true);
  });

  // A flagged row that is still logged out stays unresolved; the re-flag is a conditional
  // write against the live column (a concurrent probe may have cleared it), never a clear.
  it('keeps a still-missing already-flagged row unresolved', async () => {
    getMock.mockReturnValueOnce({ ...passthroughRow, needsReauthAt: new Date('2026-01-01') });
    probeClaudePassthroughSourceMock.mockResolvedValue({ error: 'missing' });

    const { getClaudeCodeTokenById, isResolvedCredential } = await import('./credentials');
    const result = await getClaudeCodeTokenById('passthrough-1');

    expect(isResolvedCredential(result)).toBe(false);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ needsReauthAt: expect.any(Date) }),
    );
    expect(setSpy).not.toHaveBeenCalledWith(expect.objectContaining({ needsReauthAt: null }));
  });
});

describe('getClaudeCodeTokenById — duplicate labels', () => {
  const row = (over: Record<string, unknown>) => ({
    oauthToken: null,
    source: 'claude-passthrough',
    sourcePath: null,
    expectedEmail: null,
    needsReauthAt: null,
    ...over,
  });

  beforeEach(() => {
    runMock.mockClear();
    getMock.mockReset();
    orderBySpy.mockReset();
  });

  // Two providers can both be labelled "Personal". Keyed by label the lookup had to rank
  // candidates and could hand back the other provider's row; keyed by primary key each id
  // resolves to exactly its own row, so no ranking is involved.
  it('resolves each same-labelled account to its own provider', async () => {
    const { getClaudeCodeTokenById } = await import('./credentials');

    getMock.mockReturnValueOnce(
      row({
        id: 'cred-codex',
        type: 'codex',
        accountLabel: 'Personal',
        source: 'codex-passthrough',
      }),
    );
    await expect(getClaudeCodeTokenById('cred-codex')).resolves.toMatchObject({ type: 'codex' });

    getMock.mockReturnValueOnce(
      row({ id: 'cred-claude', type: 'claude-code', accountLabel: 'Personal' }),
    );
    await expect(getClaudeCodeTokenById('cred-claude')).resolves.toMatchObject({
      type: 'claude-code',
    });
  });

  it('does not rank candidates — an id names exactly one row', async () => {
    getMock.mockReturnValueOnce(
      row({ id: 'cred-claude', type: 'claude-code', accountLabel: 'Personal' }),
    );
    const { getClaudeCodeTokenById } = await import('./credentials');
    await getClaudeCodeTokenById('cred-claude');
    expect(orderBySpy).not.toHaveBeenCalled();
  });

  // claude_code_credentials also stores GitHub PATs. The FK on project_ai_accounts constrains
  // existence, not type, so the type predicate is the only thing stopping a PAT being handed
  // to the executor as an AI credential.
  it('refuses to resolve a github credential row', async () => {
    getMock.mockReturnValueOnce(undefined);
    const { getClaudeCodeTokenById, isResolvedCredential } = await import('./credentials');
    const result = await getClaudeCodeTokenById('cred-github');
    expect(isResolvedCredential(result)).toBe(false);
    expect(result.token).toBeNull();
  });
});

describe('getDefaultCredentialForType — single-provider plan-usage resolution', () => {
  beforeEach(() => {
    getMock.mockReset();
    orderBySpy.mockReset();
    probeClaudePassthroughSourceMock.mockReset();
    probeClaudePassthroughSourceMock.mockResolvedValue({ ok: true });
  });

  it('falls back with subscription rows ranked ahead of newer API-key rows', async () => {
    getMock.mockReturnValueOnce(undefined).mockReturnValueOnce({
      id: 'claude-1',
      type: 'claude-code',
      oauthToken: null,
      accountLabel: 'Claude',
      source: 'claude-passthrough',
      sourcePath: 'keychain://Claude Code-credentials',
      expectedEmail: null,
      needsReauthAt: null,
    });
    const { getDefaultCredentialForType } = await import('./credentials');
    await expect(getDefaultCredentialForType('claude-code')).resolves.toMatchObject({
      type: 'claude-code',
      passthrough: true,
      isApiKey: false,
    });
    // resolvable rank, passthrough rank, then recency
    expect(orderBySpy.mock.calls[0]).toHaveLength(3);
  });

  it('leaves the cross-provider resolver ranking by resolvability then recency only', async () => {
    getMock.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    const { getDefaultClaudeCodeToken } = await import('./credentials');
    await getDefaultClaudeCodeToken();
    expect(orderBySpy.mock.calls[0]).toHaveLength(2);
  });
});
