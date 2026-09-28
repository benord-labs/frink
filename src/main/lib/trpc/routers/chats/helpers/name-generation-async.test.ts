import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateChatLocal: vi.fn(),
  renameSubChatLocal: vi.fn(),
  getSubChatById: vi.fn(),
  getChatById: vi.fn(),
  getProjectById: vi.fn(),
  renameProjectIfPlaceholder: vi.fn(),
  listProjects: vi.fn(),
  getProjectAiAccount: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  getClaudeCodeTokenById: vi.fn(),
  sdkQuery: vi.fn(),
  fdSpawn: vi.fn(),
  send: vi.fn(),
  captureContained: vi.fn(),
}));

vi.mock('../../../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../../db/repos/chats', () => ({
  updateChat: mocks.updateChatLocal,
  getChatById: mocks.getChatById,
}));
vi.mock('../../../../db/repos/sub-chats', () => ({
  renameSubChat: mocks.renameSubChatLocal,
  getSubChatById: mocks.getSubChatById,
}));
vi.mock('../../../../db/repos/project-ai-accounts', () => ({
  getProjectAiAccount: mocks.getProjectAiAccount,
}));
vi.mock('../../../../db/repos/projects', () => ({
  getProjectById: mocks.getProjectById,
  renameProjectIfPlaceholder: mocks.renameProjectIfPlaceholder,
  listProjects: mocks.listProjects,
}));
vi.mock('../../../../credentials', () => ({
  getDefaultClaudeCodeToken: mocks.getDefaultClaudeCodeToken,
  getClaudeCodeTokenById: mocks.getClaudeCodeTokenById,
  // Real predicate (pure, no heavy deps): "runnable, token or not". Mirroring it here keeps
  // the test honest about what counts as a resolvable assigned account. Passthrough rows
  // (claude + codex) are token-null by design — the provider binary reads its own store.
  isResolvedCredential: (c: { token: string | null; passthrough?: boolean }) =>
    !!c.token || c.passthrough === true,
}));
vi.mock('../../../../claude/env', () => ({
  buildClaudeEnv: () => ({}),
  // Mirrors the real helper: pins the canonical keychain and hands a token-bearing credential
  // to the CLI through a pipe (spawnClaudeCodeProcess), never through env.
  buildOneShotClaudeLaunch: (cred: { token: string | null; isApiKey: boolean }) => ({
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
    ...(cred.token ? { spawnClaudeCodeProcess: mocks.fdSpawn } : {}),
  }),
  getBundledClaudeBinaryPath: () => '/bundled/claude',
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.sdkQuery }));
vi.mock('electron', () => ({
  app: { getPath: () => '/home/test' },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
}));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Mocked so the contained-error report is assertable, and so its lazy `./init` import never
// pulls @sentry/electron into this suite.
vi.mock('../../../../sentry', () => ({ captureContained: mocks.captureContained }));

import {
  autoNameSubChat,
  maybeNameBuildProjectFromMessage,
  shouldReattemptProjectName,
  uniqueProjectName,
} from './name-generation-async';

const baseInput = {
  chatId: 'c1',
  subChatId: 's1',
  projectId: null,
  projectPath: null,
  rawUserMessage: 'Tell me a very long story please please please please please',
  isFirstSubChat: true,
};

function sdkYields(text: string): void {
  mocks.sdkQuery.mockReturnValue(
    (async function* () {
      yield { message: { content: [{ text }] } };
    })(),
  );
}

describe('autoNameSubChat', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Eligible by default: sub-chat and parent both unnamed.
    mocks.getSubChatById.mockResolvedValue({ name: null });
    mocks.getChatById.mockResolvedValue({ name: null });
  });

  it('uses the project-assigned account when one is set', async () => {
    mocks.getProjectAiAccount.mockResolvedValue({ id: 'cred-work', label: 'work' });
    mocks.getClaudeCodeTokenById.mockResolvedValue({
      token: 'oauth-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'work',
    });
    sdkYields('Cool Title');

    await autoNameSubChat({ ...baseInput, projectId: 'proj1' });

    expect(mocks.getProjectAiAccount).toHaveBeenCalledWith(expect.anything(), 'proj1');
    expect(mocks.getClaudeCodeTokenById).toHaveBeenCalledWith('cred-work');
    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(expect.anything(), 's1', 'Cool Title');
    expect(mocks.updateChatLocal).toHaveBeenCalledWith(expect.anything(), 'c1', {
      name: 'Cool Title',
    });
    expect(mocks.send).toHaveBeenCalledWith('chats:name-updated', {
      chatId: 'c1',
      subChatId: 's1',
      name: 'Cool Title',
    });
  });

  // A codex account is token-null passthrough: never handed to the Claude SDK, and never a
  // reason to substitute the user's default Claude account.
  it('codex-assigned chat → deterministic fallback, never the default Claude account', async () => {
    mocks.getProjectAiAccount.mockResolvedValue({ id: 'cred-codex', label: 'codex-acct' });
    mocks.getClaudeCodeTokenById.mockResolvedValue({
      token: null,
      type: 'codex',
      isApiKey: false,
      label: 'codex-acct',
      passthrough: true,
    });

    await autoNameSubChat({
      ...baseInput,
      projectId: 'proj1',
      rawUserMessage: 'fix the login bug',
    });

    expect(mocks.sdkQuery).not.toHaveBeenCalled();
    expect(mocks.getDefaultClaudeCodeToken).not.toHaveBeenCalled();
    // AI fully unavailable → deterministic fallback is the raw message (no title reshaping).
    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(
      expect.anything(),
      's1',
      'fix the login bug',
    );
  });

  // An UNRESOLVED claude-code account (mid-reauth / stale label → token-null) is NOT honoured:
  // it falls through to the default Claude account, as before. Only codex behaviour changed.
  it('falls back to default Claude when the assigned claude-code account is unresolved', async () => {
    mocks.getProjectAiAccount.mockResolvedValue({ id: 'cred-work', label: 'work' });
    mocks.getClaudeCodeTokenById.mockResolvedValue({
      token: null,
      type: 'claude-code',
      isApiKey: false,
      label: 'work',
    });
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 'default-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'default',
    });
    sdkYields('Default Title');

    await autoNameSubChat({ ...baseInput, projectId: 'proj1' });

    expect(mocks.getDefaultClaudeCodeToken).toHaveBeenCalled();
    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(expect.anything(), 's1', 'Default Title');
  });

  it('falls back to default credential when project has no assigned account', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 'default-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'default',
    });
    sdkYields('Title from default');

    await autoNameSubChat({ ...baseInput, projectId: 'proj1' });

    expect(mocks.getDefaultClaudeCodeToken).toHaveBeenCalled();
    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(
      expect.anything(),
      's1',
      'Title from default',
    );
  });

  it('extracts the first quoted candidate when the model returns several', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 'default-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'default',
    });
    sdkYields('"Fix Auth Race" or "Welcome Screen" or "Login Flow"');

    await autoNameSubChat(baseInput);

    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(expect.anything(), 's1', 'Fix Auth Race');
  });

  it('reshapes a single-word AI title into a ≥2-word Title-Case phrase from the message', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 'default-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'default',
    });
    sdkYields('Refactor'); // single word — must not be persisted as-is

    await autoNameSubChat({ ...baseInput, rawUserMessage: 'please refactor the auth module' });

    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(
      expect.anything(),
      's1',
      'Please Refactor The Auth Module',
    );
  });

  it('keeps a single-word AI title when the message is empty (no empty title persisted)', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 'default-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'default',
    });
    sdkYields('Solo'); // single word; message has no words to reshape from

    await autoNameSubChat({ ...baseInput, rawUserMessage: '' });

    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(expect.anything(), 's1', 'Solo');
  });

  it('uses haiku + isolates settings/session/hooks for the chat-title query (fast path)', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 'default-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'default',
    });
    sdkYields('Cool Title Here');

    await autoNameSubChat(baseInput);

    const opts = mocks.sdkQuery.mock.calls[0]?.[0]?.options;
    expect(opts.model).toBe('haiku');
    expect(opts.settingSources).toEqual([]);
    // Ephemeral + hook-free: no transcript in ~/.claude/projects (out of the user's session picker),
    // and no hooks fire for the background naming call.
    expect(opts.persistSession).toBe(false);
    expect(opts.settings).toEqual({ disableAllHooks: true });
    expect(opts.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      excludeDynamicSections: true,
    });
    // The token rides the pipe spawn; it never lands in the CLI env the model's Bash inherits.
    expect(opts.spawnClaudeCodeProcess).toBe(mocks.fdSpawn);
    expect(JSON.stringify(opts.env)).not.toContain('default-token');
  });

  it('falls through to deterministic fallback when every AI path fails', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: null,
      type: 'claude-code',
      isApiKey: false,
      label: null,
    });

    await autoNameSubChat(baseInput);

    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(
      expect.anything(),
      's1',
      baseInput.rawUserMessage,
    );
  });

  it('skips a sub-chat that already has a name (guard)', async () => {
    mocks.getSubChatById.mockResolvedValue({ name: 'User Renamed' });

    await autoNameSubChat(baseInput);

    expect(mocks.getProjectAiAccount).not.toHaveBeenCalled();
    expect(mocks.renameSubChatLocal).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  // Multi-pane race: naming is fire-and-forget and spans an AI call, so a user (or a second pane)
  // can rename the sub-chat while it is in flight. The re-read guard must let the human win —
  // the pre-write guard alone cannot see a rename that lands after it.
  it('does not clobber a rename that lands during the AI latency window', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 'default-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'default',
    });
    sdkYields('Generated Title');
    // Unnamed when the pre-write guard reads; renamed by the time the re-read guard checks.
    mocks.getSubChatById
      .mockResolvedValueOnce({ name: null })
      .mockResolvedValueOnce({ name: 'User Renamed Mid-Flight' });

    await autoNameSubChat(baseInput);

    expect(mocks.renameSubChatLocal).not.toHaveBeenCalled();
    expect(mocks.updateChatLocal).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  // Callers invoke this detached (`void autoNameSubChat(...)`), so a rejection here would surface
  // as an unhandled main-process rejection rather than a skipped rename. Contain, never propagate
  // — see docs/decisions/sub-chat-read-failure-posture.md.
  it('contains a read failure instead of rejecting, so a naming fault cannot crash the caller', async () => {
    mocks.getSubChatById.mockRejectedValue(new Error('SQLITE_IOERR: disk I/O error'));

    await expect(autoNameSubChat(baseInput)).resolves.toBeUndefined();

    expect(mocks.renameSubChatLocal).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    // Contained is not the same as ignored — a detached fault is only visible if it reports.
    expect(mocks.captureContained).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'chat-name',
      stage: 'pre-write-guard',
    });
  });

  it('does not rename the parent when it is not the first sub-chat', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 'default-token',
      type: 'claude-code',
      isApiKey: false,
      label: 'default',
    });
    sdkYields('Sub Title');

    await autoNameSubChat({ ...baseInput, isFirstSubChat: false });

    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(expect.anything(), 's1', 'Sub Title');
    expect(mocks.updateChatLocal).not.toHaveBeenCalled();
  });

  it('derives the name from a trigger-bubble subject', async () => {
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: null,
      type: 'claude-code',
      isApiKey: false,
      label: null,
    });
    const marker = `<!--TRIGGER_BUBBLE:${JSON.stringify({ subject: 'Fix login bug' })}-->the full prompt body that should be ignored for naming`;

    await autoNameSubChat({ ...baseInput, rawUserMessage: marker });

    // AI failed → deterministic fallback runs over the parsed subject, not the raw marker.
    expect(mocks.renameSubChatLocal).toHaveBeenCalledWith(expect.anything(), 's1', 'Fix login bug');
  });
});

describe('maybeNameBuildProjectFromMessage', () => {
  const BUILD_PATH = '/home/test/.frink/builds/proj'; // real isManagedBuildPath gate (home=/home/test)
  const placeholderBuild = { id: 'proj1', name: 'New project', path: BUILD_PATH };

  beforeEach(() => {
    // The builds root resolves through the home Frink owns, so sandbox that rather than app.getPath.
    vi.stubEnv('FRINK_HOME', '/home/test');
    vi.resetAllMocks();
    mocks.getProjectAiAccount.mockResolvedValue(null);
    mocks.getDefaultClaudeCodeToken.mockResolvedValue({
      token: 't',
      type: 'claude-code',
      isApiKey: false,
      label: 'd',
    });
    mocks.listProjects.mockResolvedValue([]); // no name collisions by default
    mocks.renameProjectIfPlaceholder.mockResolvedValue({ id: 'proj1', name: 'x' }); // updated a row
  });

  it('names a build from a build-intent message (placeholder → friendly) + broadcasts', async () => {
    sdkYields('Todo App');
    mocks.getProjectById.mockResolvedValue(placeholderBuild);

    await maybeNameBuildProjectFromMessage('proj1', 'build me a todo list');

    expect(mocks.renameProjectIfPlaceholder).toHaveBeenCalledWith(
      expect.anything(),
      'proj1',
      'Todo App',
      'New project',
    );
    expect(mocks.send).toHaveBeenCalledWith('projects:name-updated', {
      projectId: 'proj1',
      name: 'Todo App',
    });
    // Project naming keeps the stronger model so chit-chat abstention stays reliable.
    expect(mocks.sdkQuery.mock.calls[0]?.[0]?.options?.model).toBe('sonnet');
  });

  // A codex-assigned build keeps its placeholder rather than borrowing the default Claude account.
  it('codex-assigned build keeps the placeholder — never the default Claude account', async () => {
    mocks.getProjectAiAccount.mockResolvedValue({ id: 'cred-codex', label: 'codex-acct' });
    mocks.getClaudeCodeTokenById.mockResolvedValue({
      token: null,
      type: 'codex',
      isApiKey: false,
      label: 'codex-acct',
      passthrough: true,
    });
    mocks.getProjectById.mockResolvedValue(placeholderBuild);

    await maybeNameBuildProjectFromMessage('proj1', 'build me a todo list');

    expect(mocks.sdkQuery).not.toHaveBeenCalled();
    expect(mocks.getDefaultClaudeCodeToken).not.toHaveBeenCalled();
    expect(mocks.renameProjectIfPlaceholder).not.toHaveBeenCalled();
  });

  it('ABSTAINS on chit-chat (model replies NONE / "Project: NONE") → no rename', async () => {
    mocks.getProjectById.mockResolvedValue(placeholderBuild);

    for (const reply of ['NONE', 'Project: NONE', 'None.']) {
      mocks.renameProjectIfPlaceholder.mockClear();
      mocks.send.mockClear();
      sdkYields(reply);
      await maybeNameBuildProjectFromMessage('proj1', 'hello!');
      expect(mocks.renameProjectIfPlaceholder).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    }
  });

  it('keeps the placeholder when every AI path fails (no message-slice fallback)', async () => {
    sdkYields(''); // claude yields nothing → null
    mocks.getProjectById.mockResolvedValue(placeholderBuild);

    await maybeNameBuildProjectFromMessage('proj1', 'build me a todo list');

    expect(mocks.renameProjectIfPlaceholder).not.toHaveBeenCalled();
  });

  it('dedups a display-name collision → "X 2"', async () => {
    sdkYields('test');
    mocks.getProjectById.mockResolvedValue({ id: 'proj2', name: 'New project', path: BUILD_PATH });
    mocks.listProjects.mockResolvedValue([
      { id: 'proj1', name: 'test' }, // sibling already named "test"
      { id: 'proj2', name: 'New project' }, // self (placeholder) — excluded
    ]);

    await maybeNameBuildProjectFromMessage('proj2', 'build a test thing');

    expect(mocks.renameProjectIfPlaceholder).toHaveBeenCalledWith(
      expect.anything(),
      'proj2',
      'test 2',
      'New project',
    );
  });

  it('idempotent: a losing concurrent caller (0 rows updated) skips the broadcast', async () => {
    sdkYields('Todo App');
    mocks.getProjectById.mockResolvedValue(placeholderBuild);
    mocks.renameProjectIfPlaceholder.mockResolvedValue(null); // another caller already named it

    await maybeNameBuildProjectFromMessage('proj1', 'build me a todo list');

    expect(mocks.renameProjectIfPlaceholder).toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips a regular (non-build) project', async () => {
    sdkYields('Whatever');
    mocks.getProjectById.mockResolvedValue({
      id: 'proj1',
      name: 'New project',
      path: '/home/test/code/my-repo',
    });

    await maybeNameBuildProjectFromMessage('proj1', 'build a thing');

    expect(mocks.renameProjectIfPlaceholder).not.toHaveBeenCalled();
  });

  it('skips a build whose name already resolved or was user-renamed', async () => {
    sdkYields('Ignored');
    mocks.getProjectById.mockResolvedValue({
      id: 'proj1',
      name: 'Existing Name',
      path: BUILD_PATH,
    });

    await maybeNameBuildProjectFromMessage('proj1', 'build a thing');

    expect(mocks.renameProjectIfPlaceholder).not.toHaveBeenCalled();
  });
});

describe('shouldReattemptProjectName (socket cap)', () => {
  it('attempts on messages 1..MAX (catches goal-in-message-2), skips past the cap and on 0', () => {
    expect(shouldReattemptProjectName(0)).toBe(false);
    expect(shouldReattemptProjectName(1)).toBe(true);
    expect(shouldReattemptProjectName(2)).toBe(true); // EC8: not capped at message 1
    expect(shouldReattemptProjectName(5)).toBe(true);
    expect(shouldReattemptProjectName(6)).toBe(false);
  });
});

describe('uniqueProjectName', () => {
  it('returns the base when free, else appends an incrementing suffix', () => {
    expect(uniqueProjectName('test', new Set())).toBe('test');
    expect(uniqueProjectName('test', new Set(['test']))).toBe('test 2');
    expect(uniqueProjectName('test', new Set(['test', 'test 2']))).toBe('test 3');
  });

  it('fills the lowest free gap rather than always climbing', () => {
    // "test 2" is free even though "test 3" is taken — use it.
    expect(uniqueProjectName('test', new Set(['test', 'test 3']))).toBe('test 2');
  });
});
