import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDescriptionCredentialAttemptsMock = vi.fn();
const queryMock = vi.fn();

vi.mock('./credentials', () => ({
  MAX_DESCRIPTION_ACCOUNT_ATTEMPTS: 3,
  getDescriptionCredentialAttempts: getDescriptionCredentialAttemptsMock,
  // Mirrors the real predicate (credentials.ts): passthrough rows are token-null by design,
  // so `passthrough` — not token presence — is what gates a usable credential.
  isResolvedCredential: (
    cred: { token?: string | null; passthrough?: boolean } | null | undefined,
  ) => !!cred?.token || cred?.passthrough === true,
}));

vi.mock('./claude', () => ({
  buildClaudeEnv: () => ({}),
  // Mirrors the real helper: strips inherited auth, pins the canonical keychain, then adds
  // back only the selected credential's token (passthrough contributes none).
  buildOneShotClaudeEnv: (cred: { token: string | null; isApiKey: boolean }) => ({
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    ...(cred.token
      ? cred.isApiKey
        ? { ANTHROPIC_API_KEY: cred.token }
        : { CLAUDE_CODE_OAUTH_TOKEN: cred.token }
      : {}),
  }),
  getBundledClaudeBinaryPath: () => '/bundled/claude',
}));

vi.mock('./describe-repo-permission', () => ({
  allowReadOnlyUnderProject: () => ({ allowed: true }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

async function* sdkStreamWithText(text: string) {
  yield { message: { content: [{ text }] } };
}

describe('generateProjectDescriptionWithClaude', () => {
  beforeEach(() => {
    getDescriptionCredentialAttemptsMock.mockReset();
    queryMock.mockReset();
  });

  it('falls back to next credential when first attempt fails', async () => {
    getDescriptionCredentialAttemptsMock.mockReturnValue([
      { token: 'a', label: 'A', isApiKey: true, type: 'claude-code' },
      { token: 'claude-token', label: 'Claude', isApiKey: false, type: 'claude-code' },
    ]);
    queryMock
      .mockImplementationOnce(() => {
        throw new Error('sdk failure');
      })
      .mockReturnValueOnce(sdkStreamWithText('Repository summary from Claude'));

    const { generateProjectDescriptionWithClaude } = await import('./describe-repo-with-claude');
    const result = await generateProjectDescriptionWithClaude('/tmp/project');

    expect(result.description).toBe('Repository summary from Claude');
    expect(result.warning).toBeNull();
    expect(result.attemptsTried).toBe(2);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('caps failed attempts to three', async () => {
    getDescriptionCredentialAttemptsMock.mockReturnValue([
      { token: 'a', label: 'A', isApiKey: true, type: 'claude-code' },
      { token: 'b', label: 'B', isApiKey: true, type: 'claude-code' },
      { token: 'c', label: 'C', isApiKey: true, type: 'claude-code' },
      { token: 'd', label: 'D', isApiKey: true, type: 'claude-code' },
    ]);
    queryMock.mockImplementation(() => {
      throw new Error('sdk failure');
    });

    const { generateProjectDescriptionWithClaude } = await import('./describe-repo-with-claude');
    const result = await generateProjectDescriptionWithClaude('/tmp/project');

    expect(result.description).toBeNull();
    expect(result.warning).toContain('3 attempt(s)');
    expect(result.attemptsTried).toBe(3);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('returns warning when no credentials are available', async () => {
    getDescriptionCredentialAttemptsMock.mockReturnValue([]);

    const { generateProjectDescriptionWithClaude } = await import('./describe-repo-with-claude');
    const result = await generateProjectDescriptionWithClaude('/tmp/project');

    expect(result.description).toBeNull();
    expect(result.warning).toContain('no authenticated AI accounts');
    expect(result.attemptsTried).toBe(0);
  });

  it('skips unresolved credential entries with a null token', async () => {
    getDescriptionCredentialAttemptsMock.mockReturnValue([
      { token: null, label: 'Unresolved', isApiKey: true, type: 'claude-code' },
      { token: 'claude-token', label: 'Claude', isApiKey: false, type: 'claude-code' },
    ]);
    queryMock.mockReturnValue(sdkStreamWithText('Claude summary'));

    const { generateProjectDescriptionWithClaude } = await import('./describe-repo-with-claude');
    const result = await generateProjectDescriptionWithClaude('/tmp/project');

    expect(result.description).toBe('Claude summary');
    expect(result.attemptsTried).toBe(2);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
