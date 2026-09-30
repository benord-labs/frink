import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSessionsForTest,
  createSession,
  retainSession,
} from '../../socket/claude-session-registry';

const getProjectAiAccountMock = vi.fn();
const getChatAiAccountMock = vi.fn();
const getChatByIdMock = vi.fn();
const setProjectAiAccountMock = vi.fn();
const getExistingClaudeCredentialsMock = vi.fn();
const invalidateClaudeCredentialCacheMock = vi.fn();
const runClaudeOAuthBrowserMock = vi.fn();
const selectGetMock = vi.fn();
const selectAllMock = vi.fn();
const insertValuesRunMock = vi.fn();
const insertValuesMock = vi.fn(() => ({ run: insertValuesRunMock }));
const updateRunMock = vi.fn();
const deleteRunMock = vi.fn();
const renameProjectAiAccountsByLabelMock = vi.fn().mockResolvedValue(undefined);
const deleteProjectAiAccountsByLabelMock = vi.fn().mockResolvedValue(undefined);
const openExternalMock = vi.fn();
const detectCodexAccountMock = vi.fn();
// Mutable so a per-test toggle of the dark-launch flag works — the router reads
// LAUNCH_FLAGS.codexAccounts at call time, and it is the ONLY flag the router reads.
const launchFlagsMock = { codexAccounts: false };

function mockAnthropicOAuthValidation401() {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 401,
    text: async () => 'OAuth authentication is currently not supported',
  } as Response);
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock'),
  },
  shell: {
    openExternal: openExternalMock,
  },
}));

vi.mock('../../claude-oauth-browser', () => ({
  runClaudeOAuthBrowser: runClaudeOAuthBrowserMock,
}));

// `claude-token.ts` was removed in the passthrough rewrite. The remaining test
// helpers below kept their old mock-handle names so we don't churn the rest of
// the file — only their wiring changed.
const _getExistingClaudeCredentialsUnused = getExistingClaudeCredentialsMock;
const _invalidateClaudeCredentialCacheUnused = invalidateClaudeCredentialCacheMock;
void _getExistingClaudeCredentialsUnused;
void _invalidateClaudeCredentialCacheUnused;

// Project↔account routing moved to local SQLite repos during the local-first
// migration. The router imports these from db/repos/*, not cloud-client.
vi.mock('../../db/repos/chats', () => ({ getChatById: getChatByIdMock }));
vi.mock('../../db/repos/project-ai-accounts', () => ({
  getChatAiAccount: getChatAiAccountMock,
  getProjectAiAccount: getProjectAiAccountMock,
  setProjectAiAccount: setProjectAiAccountMock,
  deleteProjectAiAccountsByLabel: deleteProjectAiAccountsByLabelMock,
  renameProjectAiAccountsByLabel: renameProjectAiAccountsByLabelMock,
}));

// Tracks every db.transaction call so we can verify connectClaudePassthrough
// wraps its SELECT+INSERT in a transaction (Bug #20).
const transactionSpy = vi.fn();

// Tracks orderBy invocations across the file so we can assert that
// `getResolvedAccount`'s project-account / default-account branches apply a
// tie-breaker (Bug #C) — without an orderBy, two rows with the same label
// resolve nondeterministically and the user gets the wrong (unauthenticated)
// row picked.
const resolvedAccountOrderBySpy = vi.fn();

vi.mock('../../db', () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({
        all: selectAllMock,
        limit: () => ({
          get: selectGetMock,
        }),
        where: () => ({
          get: selectGetMock,
          all: selectAllMock,
          limit: () => ({
            get: selectGetMock,
          }),
          orderBy: (...args: unknown[]) => {
            resolvedAccountOrderBySpy(...args);
            return {
              get: selectGetMock,
              all: selectAllMock,
              limit: () => ({
                get: selectGetMock,
              }),
            };
          },
        }),
      }),
    }),
    insert: () => ({
      values: insertValuesMock,
    }),
    update: () => ({
      set: () => ({
        where: () => ({ run: updateRunMock }),
      }),
    }),
    delete: () => ({
      where: () => ({ run: deleteRunMock }),
    }),
    // drizzle transaction API: invokes the callback with a tx handle (we ignore
    // it here) and returns the callback's value directly.
    transaction: <T>(fn: (...args: unknown[]) => T): T => {
      transactionSpy(fn);
      return fn();
    },
  }),
  claudeCodeCredentials: {
    id: {},
    accountLabel: {},
    type: {},
    isDefault: {},
    connectedAt: {},
    oauthToken: {},
    source: {},
    sourcePath: {},
    expectedEmail: {},
    needsReauthAt: {},
    lastResolvedFromSourceAt: {},
  },
}));

vi.mock('../../db/utils', () => ({ createId: () => 'new-id' }));

const getClaudeCodeTokenByIdMock = vi.fn();

vi.mock('../../credentials', () => ({
  decryptToken: vi.fn((x: string) => x),
  getClaudeCodeTokenById: getClaudeCodeTokenByIdMock,
  encryptToken: vi.fn((x: string) => x),
  isPassthroughSource: (source: string | null | undefined) =>
    source === 'claude-passthrough' || source === 'codex-passthrough',
  // RESOLVABLE_FIRST_RANK is a `sql\`...\`` template — tests don't execute the
  // query, they spy on `.orderBy(...)` args, so any drizzle SQL value is fine.
  RESOLVABLE_FIRST_RANK: { __mockedSqlFragment: 'resolvable-first-rank' },
}));

const detectClaudeAccountMock = vi.fn().mockResolvedValue({
  available: true,
  email: 'me@example.com',
  displayName: 'me@example.com',
  sourcePath: 'darwin-keychain://Claude%20Code-credentials',
});
vi.mock('../../credentials/detect', () => ({
  detectClaudeAccount: detectClaudeAccountMock,
}));

vi.mock('../../credentials/source-readers', () => ({
  // Mirror the runtime export so the zod schema in connectClaudePassthrough
  // can read the allowlist (used in the .refine() check).
  ALLOWED_SOURCE_PATH_SCHEMES: ['darwin-keychain://', 'file://'] as const,
  KEYCHAIN_READ_TIMEOUT_MS: 1500,
}));

vi.mock('../../credentials/detect-codex', () => ({
  detectCodexAccount: detectCodexAccountMock,
}));

vi.mock('../../../../shared/launch-flags', () => ({ LAUNCH_FLAGS: launchFlagsMock }));

beforeEach(() => {});

describe('claudeCodeRouter project account ownership', () => {
  beforeEach(() => {
    getProjectAiAccountMock.mockReset();
    setProjectAiAccountMock.mockReset();
    getExistingClaudeCredentialsMock.mockReset();
    invalidateClaudeCredentialCacheMock.mockReset();
    selectGetMock.mockReset();
    selectGetMock.mockReturnValue(undefined);
    selectAllMock.mockReset();
    selectAllMock.mockReturnValue([]);
    insertValuesMock.mockClear();
    insertValuesRunMock.mockClear();
    runClaudeOAuthBrowserMock.mockReset();
    openExternalMock.mockReset();
  });

  it('returns null when no project ai-account mapping exists', async () => {
    getProjectAiAccountMock.mockResolvedValue(null);

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(caller.getProjectAccount({ projectId: 'project-remote' })).resolves.toBeNull();
    expect(getProjectAiAccountMock).toHaveBeenCalledWith(expect.anything(), 'project-remote');
  });

  it('supports text project ids on the read path', async () => {
    getProjectAiAccountMock.mockResolvedValue({ id: 'cred-work', label: 'Work' });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(caller.getProjectAccount({ projectId: 'project/1' })).resolves.toBe('cred-work');
    expect(getProjectAiAccountMock).toHaveBeenCalledWith(expect.anything(), 'project/1');
  });

  it('updates mapping by forwarding to cloud client', async () => {
    setProjectAiAccountMock.mockResolvedValue(undefined);

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(
      caller.setProjectAccount({ projectId: 'project-remote', accountId: 'cred-work' }),
    ).resolves.toEqual({ success: true });
    expect(setProjectAiAccountMock).toHaveBeenCalledWith(
      expect.anything(),
      'project-remote',
      'cred-work',
    );
  });

  it('supports text project ids on the write path', async () => {
    setProjectAiAccountMock.mockResolvedValue(undefined);

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(
      caller.setProjectAccount({ projectId: 'project/1', accountId: 'cred-work' }),
    ).resolves.toEqual({ success: true });
    expect(setProjectAiAccountMock).toHaveBeenCalledWith(
      expect.anything(),
      'project/1',
      'cred-work',
    );
  });

  it('returns mapping for owned project', async () => {
    getProjectAiAccountMock.mockResolvedValue({ id: 'cred-work', label: 'Work' });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(caller.getProjectAccount({ projectId: 'project-local' })).resolves.toBe(
      'cred-work',
    );
    expect(getProjectAiAccountMock).toHaveBeenCalledWith(expect.anything(), 'project-local');
  });

  it('updates mapping for owned project', async () => {
    setProjectAiAccountMock.mockResolvedValue(undefined);

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(
      caller.setProjectAccount({ projectId: 'project-local', accountId: 'cred-default-work' }),
    ).resolves.toEqual({ success: true });
    expect(setProjectAiAccountMock).toHaveBeenCalledWith(
      expect.anything(),
      'project-local',
      'cred-default-work',
    );
  });

  // Local-first migration: project↔account routing is a local SQLite lookup with
  // no ownership check and no HTTP-status→TRPC-code mapping (that was cloud-only).
  // A repo-level failure simply propagates as a generic error.
  it('propagates local repo read failures from getProjectAccount', async () => {
    getProjectAiAccountMock.mockRejectedValueOnce(new Error('db read failed'));

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(caller.getProjectAccount({ projectId: 'project/1' })).rejects.toThrow(
      'db read failed',
    );
  });

  it('propagates local repo write failures from setProjectAccount', async () => {
    setProjectAiAccountMock.mockRejectedValueOnce(new Error('db write failed'));

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(
      caller.setProjectAccount({ projectId: 'project-remote', accountId: 'cred-work' }),
    ).rejects.toThrow('db write failed');
  });

  it('resolves project override accounts for text project ids', async () => {
    getProjectAiAccountMock.mockResolvedValue({ id: 'cred-work', label: 'Work' });
    selectGetMock.mockReturnValue({
      id: 'cred-work',
      accountLabel: 'Work',
      type: 'claude',
      oauthToken: 'oauth-token',
    });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(caller.getResolvedAccount({ projectId: 'project/1' })).resolves.toMatchObject({
      label: 'Work',
      isProjectOverride: true,
      isAuthenticated: true,
      projectId: 'project/1',
    });
    expect(getProjectAiAccountMock).toHaveBeenCalledWith(expect.anything(), 'project/1');
  });

  it('getResolvedAccount re-probes a flagged claude-passthrough row and reports it healed', async () => {
    getProjectAiAccountMock.mockResolvedValue(null);
    getClaudeCodeTokenByIdMock.mockReset().mockResolvedValue({ token: null, passthrough: true });
    const flagged = {
      id: 'pt-1',
      accountLabel: 'Personal',
      type: 'claude-code',
      oauthToken: null,
      source: 'claude-passthrough',
      isDefault: true,
      needsReauthAt: new Date('2026-01-01'),
    };
    // First read: the ranked default select; second: the fresh re-read after the probe healed.
    selectGetMock
      .mockReturnValueOnce(flagged)
      .mockReturnValueOnce({ ...flagged, needsReauthAt: null });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(caller.getResolvedAccount({})).resolves.toMatchObject({
      id: 'pt-1',
      isAuthenticated: true,
    });
    expect(getClaudeCodeTokenByIdMock).toHaveBeenCalledWith('pt-1');
  });

  it('getResolvedAccount includes projectId when falling back to workspace default (no project AI override)', async () => {
    getProjectAiAccountMock.mockResolvedValue(null);
    selectGetMock.mockReturnValue({
      accountLabel: 'DefaultAcct',
      type: 'claude',
      oauthToken: 'oauth',
      isDefault: true,
    });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(caller.getResolvedAccount({ projectId: 'project/1' })).resolves.toMatchObject({
      label: 'DefaultAcct',
      isProjectOverride: false,
      isAuthenticated: true,
      projectId: 'project/1',
    });
    expect(getProjectAiAccountMock).toHaveBeenCalledWith(expect.anything(), 'project/1');
  });

  it('getResolvedAccount resolves a chat to its stamped account', async () => {
    getProjectAiAccountMock.mockResolvedValue({ id: 'cred-a', label: 'Personal' });
    const chat = { id: 'c1', projectId: 'project/1', accountId: 'cred-b', provider: 'claude-code' };
    getChatByIdMock.mockResolvedValueOnce(chat);
    getChatAiAccountMock.mockResolvedValueOnce({ id: 'cred-b', label: 'Work' });
    selectGetMock.mockReturnValue({
      id: 'cred-b',
      accountLabel: 'Work',
      type: 'claude-code',
      oauthToken: 'token',
      source: 'api-key',
      needsReauthAt: null,
    });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });
    const result = await caller.getResolvedAccount({ chatId: 'c1' });

    expect(getChatAiAccountMock).toHaveBeenCalledWith(expect.anything(), chat);
    expect(result).toMatchObject({
      id: 'cred-b',
      label: 'Work',
      projectId: 'project/1',
      isProjectOverride: false,
    });
  });

  // Replaces the old label tie-break test: the project-account branch used to rank rows
  // sharing an accountLabel. It now selects by primary key, so ranking would be a bug —
  // the inverted orderBy assertion is what stops a heuristic being reintroduced.
  it('getResolvedAccount resolves the project override by credential id, without ranking', async () => {
    getProjectAiAccountMock.mockResolvedValue({ id: 'cred-personal', label: 'Personal Claude' });
    selectGetMock.mockReturnValue({
      id: 'cred-personal',
      accountLabel: 'Personal Claude',
      type: 'claude-code',
      oauthToken: null,
      source: 'claude-passthrough',
      sourcePath: 'darwin-keychain://Claude%20Code-credentials',
      needsReauthAt: null,
    });
    resolvedAccountOrderBySpy.mockClear();

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    const result = await caller.getResolvedAccount({ projectId: 'project/1' });

    expect(result?.id).toBe('cred-personal');
    expect(result?.isProjectOverride).toBe(true);
    expect(result?.isAuthenticated).toBe(true);
    expect(resolvedAccountOrderBySpy).not.toHaveBeenCalled();
  });

  it('getResolvedAccount ignores a project override the signed-in user cannot see', async () => {
    getProjectAiAccountMock.mockResolvedValue({ id: 'cred-other-account', label: 'Personal' });
    selectGetMock.mockReturnValueOnce(undefined).mockReturnValue({
      id: 'cred-mine',
      accountLabel: 'Personal',
      type: 'claude-code',
      oauthToken: null,
      source: 'claude-passthrough',
      sourcePath: 'darwin-keychain://Claude%20Code-credentials',
      needsReauthAt: null,
      isDefault: true,
    });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(caller.getResolvedAccount({ projectId: 'project/1' })).resolves.toMatchObject({
      id: 'cred-mine',
      isProjectOverride: false,
      isAuthenticated: true,
    });
  });

  it('getResolvedAccount applies a tie-breaker ORDER BY in the default-account branch (Bug #C-1)', async () => {
    // Same bug in the no-project default-account branch.
    getProjectAiAccountMock.mockResolvedValue(null);
    selectGetMock.mockReturnValue({
      accountLabel: 'Personal Claude',
      type: 'claude-code',
      oauthToken: null,
      source: 'claude-passthrough',
      sourcePath: 'darwin-keychain://Claude%20Code-credentials',
      needsReauthAt: null,
      isDefault: true,
    });
    resolvedAccountOrderBySpy.mockClear();

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    const result = await caller.getResolvedAccount({});

    expect(result?.isAuthenticated).toBe(true);
    expect(resolvedAccountOrderBySpy).toHaveBeenCalled();
  });

  it('does not fall back to the default account when project resolution fails', async () => {
    // Local-first: project resolution is a local SQLite read. If it fails we
    // surface the error rather than silently resolving the workspace default
    // (which could route the chat to the wrong account).
    getProjectAiAccountMock.mockRejectedValueOnce(new Error('db read failed'));
    selectGetMock.mockReturnValue({
      accountLabel: 'Default',
      type: 'claude',
      oauthToken: 'oauth-token',
      isDefault: true,
    });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({
      getWindow: () => null,
    });

    await expect(caller.getResolvedAccount({ projectId: 'project/1' })).rejects.toThrow(
      'db read failed',
    );
  });
});

// `getSystemToken` and `importSystemToken` were removed in the claude-passthrough
// rewrite. Their behavior is replaced by `detectClaudeAccount` / `connectClaudePassthrough`,
// covered by the new credentials/* tests.

describe('claudeCodeRouter updateAccountToken', () => {
  beforeEach(() => {
    getExistingClaudeCredentialsMock.mockReset();
    selectGetMock.mockReset();
    updateRunMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('replaces the stored token locally', async () => {
    mockAnthropicOAuthValidation401();
    selectGetMock
      .mockReturnValueOnce({
        id: 'acc-1',
        accountLabel: 'Work Claude',
        type: 'claude-code',
        isDefault: false,
      })
      .mockReturnValueOnce({ id: 'acc-1', oauthToken: null });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(caller.updateAccountToken({ id: 'acc-1', token: 'oauth-token' })).resolves.toEqual(
      { success: true },
    );
  });
});

describe('claudeCodeRouter retires idle Claude sessions when a credential goes away', () => {
  /** A session idling between turns: its CLI env still carries the credential it spawned with. */
  const idleSession = () => {
    const close = vi.fn();
    const next = () => new Promise(() => {});
    retainSession(createSession('idle-sub', () => ({ close, next }) as unknown as Query));
    return close;
  };
  const caller = async () =>
    (await import('./claude-code')).claudeCodeRouter.createCaller({ getWindow: () => null });

  beforeEach(() => {
    __resetSessionsForTest();
    selectGetMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('on account delete', async () => {
    const close = idleSession();
    selectGetMock.mockReturnValueOnce({ id: 'acc-1', isDefault: false });
    await (await caller()).deleteAccount({ id: 'acc-1' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('on token rotation', async () => {
    const close = idleSession();
    mockAnthropicOAuthValidation401();
    selectGetMock
      .mockReturnValueOnce({ id: 'acc-1', type: 'claude-code', isDefault: false })
      .mockReturnValueOnce({ id: 'acc-1', oauthToken: null });
    await (await caller()).updateAccountToken({ id: 'acc-1', token: 'oauth-token' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('on passthrough disconnect', async () => {
    const close = idleSession();
    selectGetMock.mockReturnValueOnce({ id: 'acc-2', source: 'claude-passthrough' });
    await (await caller()).disconnectClaudePassthrough({ accountId: 'acc-2' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('on a re-auth that converts a token row to passthrough', async () => {
    const close = idleSession();
    selectGetMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: 'other-1' })
      .mockReturnValueOnce({ id: 'acc-3', accountLabel: 'Slice', source: 'api-key' });
    const router = await caller();
    const sourcePath = 'darwin-keychain://Claude%20Code-credentials';
    await router.connectClaudePassthrough({ accountLabel: 'Slice', sourcePath, reauth: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it('on a Reconnect of the existing Claude Code login', async () => {
    const close = idleSession();
    const sourcePath = 'darwin-keychain://Claude%20Code-credentials';
    selectGetMock.mockReturnValueOnce({ id: 'acc-2', accountLabel: 'Claude Code', sourcePath });
    const router = await caller();
    await router.connectClaudePassthrough({ accountLabel: 'Work', sourcePath, reauth: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it('on a token import over an existing label', async () => {
    const close = idleSession();
    mockAnthropicOAuthValidation401();
    selectGetMock.mockReturnValueOnce({ id: 'acc-1', accountLabel: 'Work' });
    await (await caller()).importToken({ token: 'oauth-token', accountLabel: 'Work' });
    expect(close).toHaveBeenCalledOnce();
  });
});

// Contract tests for the reduced /ai-accounts/including-deleted payload (sc-72):
// the reconciler consumes only id, account_label, account_type, deleted_at, so the
// two business fields (account_type, deleted_at) must still drive their branches.
describe('claudeCodeRouter renameAccount', () => {
  beforeEach(() => {
    selectGetMock.mockReset();
    updateRunMock.mockReset();
    renameProjectAiAccountsByLabelMock.mockReset().mockResolvedValue(undefined);
  });

  it('renames the local row', async () => {
    selectGetMock.mockReturnValueOnce(undefined).mockReturnValueOnce({
      id: 'acc-1',
      accountLabel: 'OldLabel',
      type: 'claude-code',
      isDefault: false,
    });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(caller.renameAccount({ id: 'acc-1', newLabel: 'NewLabel' })).resolves.toEqual({
      success: true,
    });
    expect(updateRunMock).toHaveBeenCalled();
  });

  it('rejects a rename to a label another account already holds', async () => {
    selectGetMock.mockReturnValueOnce({ id: 'acc-other', accountLabel: 'NewLabel' });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(caller.renameAccount({ id: 'acc-1', newLabel: 'NewLabel' })).rejects.toThrow(
      'Account "NewLabel" already exists',
    );
  });
});

describe('claudeCodeRouter connectClaudePassthrough — sourcePath input validation (pre-commit api-security)', () => {
  beforeEach(() => {
    selectGetMock.mockReset();
    insertValuesMock.mockClear();
    insertValuesRunMock.mockClear();
    transactionSpy.mockReset();
    detectClaudeAccountMock.mockClear();
  });

  it('rejects sourcePath with an unknown URI scheme', async () => {
    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });
    await expect(
      caller.connectClaudePassthrough({
        accountLabel: 'Personal Claude',
        // not in ALLOWED_SOURCE_PATH_SCHEMES — could route to RCE or random reader
        sourcePath: 'http://example.com/keychain.json',
      }),
    ).rejects.toThrow(/sourcePath must use one of/);
    // Mutation handler should NOT have run.
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('mirrors the real ALLOWED_SOURCE_PATH_SCHEMES allowlist', async () => {
    // The zod refine is only as good as this mock: a drifted copy would test the wrong list.
    const actual = await vi.importActual<typeof import('../../credentials/source-readers')>(
      '../../credentials/source-readers',
    );
    const mocked = await import('../../credentials/source-readers');
    expect(mocked.ALLOWED_SOURCE_PATH_SCHEMES).toEqual(actual.ALLOWED_SOURCE_PATH_SCHEMES);
  });

  it('rejects secret-tool:// sourcePath (Linux keyring is not a source the Claude CLI reads)', async () => {
    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });
    await expect(
      caller.connectClaudePassthrough({
        accountLabel: 'Personal Claude',
        sourcePath: 'secret-tool://Claude%20Code/credentials',
      }),
    ).rejects.toThrow(/sourcePath must use one of/);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('rejects file:// sourcePath that escapes ~/.claude/', async () => {
    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });
    await expect(
      caller.connectClaudePassthrough({
        accountLabel: 'Personal Claude',
        sourcePath: 'file:///etc/passwd',
      }),
    ).rejects.toThrow(/file:\/\/ sourcePath must reference a path under ~\/.claude\//);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('accepts darwin-keychain:// scheme', async () => {
    selectGetMock.mockReturnValue(undefined);
    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });
    // Smoke test: validation passes; the rest of the flow may or may not insert
    // depending on test mocks, but it should not throw a zod error.
    await expect(
      caller.connectClaudePassthrough({
        accountLabel: 'Personal Claude',
        sourcePath: 'darwin-keychain://Claude%20Code-credentials',
      }),
    ).resolves.toBeDefined();
  });
});

describe('claudeCodeRouter connectClaudePassthrough — concurrency (Bug #20)', () => {
  beforeEach(() => {
    selectGetMock.mockReset();
    insertValuesMock.mockClear();
    insertValuesRunMock.mockClear();
    updateRunMock.mockClear();
    transactionSpy.mockReset();
    detectClaudeAccountMock.mockClear();
  });

  it('wraps the SELECT-then-INSERT in db.transaction so two concurrent calls cannot both insert', async () => {
    // Bug #20: prior to the fix the procedure did SELECT (no existing row) then
    // INSERT, separately. Two concurrent calls (e.g. user double-clicks Connect)
    // could both pass the existence check and both insert, ending with two
    // passthrough rows on the same machine — violating the one-per-machine
    // invariant. Wrapping in db.transaction is what makes this safe.
    selectGetMock.mockReturnValue(undefined);

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await caller.connectClaudePassthrough({
      accountLabel: 'Claude Code',
      sourcePath: 'darwin-keychain://Claude%20Code-credentials',
    });

    // The transaction wrapper must have been invoked at least once during the
    // mutation. Without the fix the SELECT+INSERT happens at the top level and
    // transactionSpy stays at 0.
    expect(transactionSpy).toHaveBeenCalled();
  });

  it('rejects collision even when the existing row has NULL userId (orphaned pre-user-scoping row, Bug #C-2)', async () => {
    // The original collision check was user-scoped via `eq(userId, current)`.
    // Old rows from before user-scoping have userId = NULL and slip through,
    // so the user gets a duplicate "Personal Claude" row anyway. The fix
    // widens the check to ALSO match userId IS NULL.
    selectGetMock
      .mockReturnValueOnce(undefined) // existing passthrough by source — none
      .mockReturnValueOnce({ id: 'other-1' }) // first-account guard → not first
      .mockReturnValueOnce({
        // collision row, but with userId = null (orphan)
        id: 'orphan-personal',
        accountLabel: 'Personal Claude',
        type: 'claude-code',
        oauthToken: null,
        source: 'api-key',
        userId: null,
      });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.connectClaudePassthrough({
        accountLabel: 'Personal Claude',
        sourcePath: 'darwin-keychain://Claude%20Code-credentials',
      }),
    ).rejects.toThrow(/already exists|different label|disconnect/i);

    expect(insertValuesRunMock).not.toHaveBeenCalled();
  });

  it('in reauth mode, CONVERTS an existing api-key row in place instead of rejecting (Bug #E)', async () => {
    // Bug #E: when the user clicks "Reconnect" on an existing Claude account
    // (api-key row with no token, or stale token), the empty-state CTA opens
    // ConnectClaudeAccountPage in reauth mode. Without `reauth: true` the
    // procedure's collision check rejects with "An account named X already
    // exists" — which is exactly what the user is trying to fix.
    //
    // Post-fix: when `reauth: true`, the existing same-label claude-code row
    // is CONVERTED to passthrough in place (source='claude-passthrough',
    // sourcePath set, oauth_token cleared, needsReauthAt cleared). Same id,
    // same isDefault, same cloud sync — just a credential-source flip.
    selectGetMock
      .mockReturnValueOnce(undefined) // existing passthrough by source — none
      .mockReturnValueOnce({ id: 'other-1' }) // first-account guard → not first
      .mockReturnValueOnce({
        // collision row that should be CONVERTED, not rejected
        id: 'existing-slice',
        accountLabel: 'Slice',
        type: 'claude-code',
        oauthToken: null,
        source: 'api-key',
      });
    updateRunMock.mockClear();

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    const result = await caller.connectClaudePassthrough({
      accountLabel: 'Slice',
      sourcePath: 'darwin-keychain://Claude%20Code-credentials',
      reauth: true,
    });

    expect(result).toMatchObject({ accountId: 'existing-slice', status: 'updated' });
    // No new row inserted — we converted the existing one.
    expect(insertValuesRunMock).not.toHaveBeenCalled();
    // The conversion goes through UPDATE.
    expect(updateRunMock).toHaveBeenCalled();
  });

  it('in NON-reauth mode, rejects silent rename of an existing passthrough (Bug #F)', async () => {
    // Bug #F: when a passthrough already exists for this machine's keychain
    // entry and the user opens "Add Account" → "Use Claude Code login" with
    // a different label, the procedure was silently UPDATEing the existing
    // row's label. The user thought they were creating a new account; they
    // were actually renaming Personal Claude → test.
    //
    // Post-fix: in non-reauth mode, an existing same-sourcePath passthrough
    // is treated as a collision (one passthrough per device). Reject so the
    // user understands they need to edit the existing row instead.
    selectGetMock.mockReturnValueOnce({
      // existing passthrough row, SAME sourcePath as the new request
      id: 'existing-passthrough',
      accountLabel: 'Personal Claude',
      type: 'claude-code',
      oauthToken: null,
      source: 'claude-passthrough',
      sourcePath: 'darwin-keychain://Claude%20Code-credentials',
    });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.connectClaudePassthrough({
        accountLabel: 'test',
        sourcePath: 'darwin-keychain://Claude%20Code-credentials',
        // reauth NOT set → caller intends a brand-new account
      }),
    ).rejects.toThrow(/already connected|one Claude Code login|edit/i);

    expect(insertValuesRunMock).not.toHaveBeenCalled();
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it('rejects when an api-key row already exists with the same label (Bug #B)', async () => {
    // Edge-case Bug #B: empty-state's "Reconnect Claude" CTA reuses the existing
    // row's accountLabel and routes to ConnectClaudeAccountPage. If that label
    // already belongs to an api-key row (not a passthrough row), creating a new
    // passthrough silently produces TWO rows with the same label — and
    // getClaudeCodeTokenByLabel's tie-breaker would resolve them
    // unpredictably from the user's perspective.
    selectGetMock.mockImplementation((): unknown => {
      // 1st SELECT: existing passthrough lookup → none.
      // 2nd SELECT: any-claude lookup for `isFirstAccount` → returns the
      // existing api-key row, so isFirstAccount becomes false.
      // 3rd SELECT (the new label-collision check we're testing): same-label
      // api-key row exists.
      return undefined;
    });

    // Precise sequence: passthrough lookup → undefined; first-account guard →
    // some other row; SAME-LABEL api-key check → returns a row.
    selectGetMock
      .mockReturnValueOnce(undefined) // existing passthrough by source — none
      .mockReturnValueOnce({ id: 'other-1' }) // any account exists → not first
      .mockReturnValueOnce({
        // same-label api-key collision
        id: 'api-key-personal',
        accountLabel: 'Personal',
        type: 'claude-code',
        oauthToken: 'sk-ant-api03-existing',
        source: 'api-key',
      });

    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.connectClaudePassthrough({
        accountLabel: 'Personal',
        sourcePath: 'darwin-keychain://Claude%20Code-credentials',
      }),
    ).rejects.toThrow(/already exists|different label|disconnect/i);

    // No INSERT should have happened.
    expect(insertValuesRunMock).not.toHaveBeenCalled();
  });
});

describe('claudeCodeRouter connectCodexPassthrough — dark-launch creation gate', () => {
  beforeEach(() => {
    selectGetMock.mockReset();
    insertValuesMock.mockClear();
    insertValuesRunMock.mockClear();
    updateRunMock.mockClear();
    transactionSpy.mockReset();
    detectCodexAccountMock.mockReset();
    launchFlagsMock.codexAccounts = true; // default ON; the guard test flips it off
    detectCodexAccountMock.mockReturnValue({
      available: true,
      email: 'me@openai.example',
      displayName: 'me@openai.example',
      sourcePath: 'codex-passthrough://local',
    });
  });

  it('refuses to persist while the dark-launch flag is off (server-side guard, not just UI)', async () => {
    // A tRPC mutation is reachable from DevTools/automation even when the UI is gated.
    // While codex ships dark, the server itself MUST reject so no codex row can be created.
    launchFlagsMock.codexAccounts = false;
    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(caller.connectCodexPassthrough({ accountLabel: 'Codex' })).rejects.toThrow(
      /not enabled/i,
    );
    // Guard short-circuits before detection or any DB write.
    expect(detectCodexAccountMock).not.toHaveBeenCalled();
    expect(insertValuesRunMock).not.toHaveBeenCalled();
  });

  it('throws the detector hint when the codex binary is not logged in on this machine', async () => {
    detectCodexAccountMock.mockReturnValue({
      available: false,
      hint: 'No Codex login found. Run `codex login` and try again.',
    });
    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    await expect(caller.connectCodexPassthrough({ accountLabel: 'Codex' })).rejects.toThrow(
      /codex login/i,
    );
    expect(insertValuesRunMock).not.toHaveBeenCalled();
  });

  it('inserts a token-null codex row marked default when it is the first account', async () => {
    selectGetMock
      .mockReturnValueOnce(undefined) // no existing codex-passthrough row
      .mockReturnValueOnce(undefined); // no claude rows → first account
    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    const result = await caller.connectCodexPassthrough({ accountLabel: 'My Codex' });

    expect(result).toMatchObject({ accountId: 'new-id', status: 'created' });
    expect(insertValuesRunMock).toHaveBeenCalled();
    // Token-null passthrough, codex type/source, machine-local sourcePath, default (first account).
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'codex',
        oauthToken: null,
        source: 'codex-passthrough',
        sourcePath: 'codex-passthrough://local',
        isDefault: true,
        expectedEmail: 'me@openai.example',
      }),
    );
    expect(transactionSpy).toHaveBeenCalled(); // SELECT+INSERT atomic (one-per-machine safety)
  });

  it('updates the existing codex row in place — one codex login per machine, never a second row', async () => {
    selectGetMock.mockReturnValueOnce({ id: 'codex-existing' }); // existing codex-passthrough row
    const { claudeCodeRouter } = await import('./claude-code');
    const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

    const result = await caller.connectCodexPassthrough({ accountLabel: 'Renamed Codex' });

    expect(result).toMatchObject({ accountId: 'codex-existing', status: 'updated' });
    expect(updateRunMock).toHaveBeenCalled();
    expect(insertValuesRunMock).not.toHaveBeenCalled();
  });
});

describe('claudeCodeRouter — codex account-type recognition in the selection reads (sc-923)', () => {
  beforeEach(() => {
    selectGetMock.mockReset();
    selectAllMock.mockReset();
    detectCodexAccountMock.mockReset();
    launchFlagsMock.codexAccounts = true;
  });

  describe('detectCodexAccount query', () => {
    it('returns unavailable while the flag is dark — never probes the machine', async () => {
      launchFlagsMock.codexAccounts = false;
      const { claudeCodeRouter } = await import('./claude-code');
      const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

      await expect(caller.detectCodexAccount()).resolves.toEqual({
        available: false,
        hint: 'Codex accounts are not enabled.',
      });
      expect(detectCodexAccountMock).not.toHaveBeenCalled();
    });

    it('returns the detector result when the flag is on', async () => {
      detectCodexAccountMock.mockReturnValue({
        available: true,
        email: 'me@openai.example',
        sourcePath: 'codex-passthrough://local',
      });
      const { claudeCodeRouter } = await import('./claude-code');
      const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

      await expect(caller.detectCodexAccount()).resolves.toMatchObject({
        available: true,
        email: 'me@openai.example',
      });
    });
  });

  describe('listAccounts', () => {
    it('surfaces a token-null codex row as type codex, label OpenAI, authenticated (not an api key)', async () => {
      selectAllMock.mockReturnValueOnce([
        {
          id: 'cx',
          accountLabel: null,
          type: 'codex',
          oauthToken: null,
          source: 'codex-passthrough',
          needsReauthAt: null,
          isDefault: true,
          connectedAt: null,
          sourcePath: 'codex-passthrough://local',
          expectedEmail: 'me@openai.example',
        },
      ]);
      const { claudeCodeRouter } = await import('./claude-code');
      const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

      const [acc] = await caller.listAccounts();
      expect(acc).toMatchObject({
        type: 'codex',
        label: 'OpenAI',
        isAuthenticated: true,
        isApiKey: false,
      });
    });

    it('marks a needs-reauth codex row unauthenticated (token-null ≠ unauth, reauth flag governs)', async () => {
      selectAllMock.mockReturnValueOnce([
        {
          id: 'cx',
          accountLabel: 'My Codex',
          type: 'codex',
          oauthToken: null,
          source: 'codex-passthrough',
          needsReauthAt: new Date(),
          isDefault: false,
          connectedAt: null,
          sourcePath: null,
          expectedEmail: null,
        },
      ]);
      const { claudeCodeRouter } = await import('./claude-code');
      const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

      const [acc] = await caller.listAccounts();
      expect(acc).toMatchObject({ type: 'codex', label: 'My Codex', isAuthenticated: false });
    });
  });

  describe('getResolvedAccount', () => {
    it('resolves a default codex row to type codex, authenticated', async () => {
      selectGetMock.mockReturnValueOnce({
        accountLabel: 'My Codex',
        type: 'codex',
        source: 'codex-passthrough',
        oauthToken: null,
        needsReauthAt: null,
        sourcePath: 'codex-passthrough://local',
        expectedEmail: 'me@openai.example',
        isDefault: 1,
      });
      const { claudeCodeRouter } = await import('./claude-code');
      const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

      await expect(caller.getResolvedAccount({})).resolves.toMatchObject({
        type: 'codex',
        isAuthenticated: true,
        label: 'My Codex',
      });
    });
  });

  describe('getIntegration — passthrough-aware isConnected (fixes a pre-existing bug)', () => {
    it('reports a token-null claude-passthrough account as connected', async () => {
      // Pre-fix: `!!oauthToken` read this (NULL by design) as disconnected.
      selectGetMock.mockReturnValueOnce({
        source: 'claude-passthrough',
        oauthToken: null,
        needsReauthAt: null,
        connectedAt: null,
      });
      const { claudeCodeRouter } = await import('./claude-code');
      const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

      await expect(caller.getIntegration()).resolves.toMatchObject({ isConnected: true });
    });

    it('reports a token-null codex-passthrough account as connected', async () => {
      selectGetMock.mockReturnValueOnce({
        source: 'codex-passthrough',
        oauthToken: null,
        needsReauthAt: null,
        connectedAt: null,
      });
      const { claudeCodeRouter } = await import('./claude-code');
      const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

      await expect(caller.getIntegration()).resolves.toMatchObject({ isConnected: true });
    });

    it('reports a needs-reauth passthrough account as disconnected', async () => {
      selectGetMock.mockReturnValueOnce({
        source: 'codex-passthrough',
        oauthToken: null,
        needsReauthAt: new Date(),
        connectedAt: null,
      });
      const { claudeCodeRouter } = await import('./claude-code');
      const caller = claudeCodeRouter.createCaller({ getWindow: () => null });

      await expect(caller.getIntegration()).resolves.toMatchObject({ isConnected: false });
    });
  });
});
