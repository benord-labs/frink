import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getClaudeShellEnvironment() shells out to an interactive LOGIN shell (`zsh -ilc`), which costs
// ~0.7s and yields whatever the developer's profile happens to export. Every other consumer of
// this module mocks it away; this file tests it directly, so it stubs the subprocess instead.
// Without this the 13 tests below spawn 13 real shells — slow, machine-dependent, and enough CPU
// load to time out sibling suites sharing the worker pool.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(
    () =>
      '_CLAUDE_ENV_DELIMITER_HOME=/mock/home\nUSER=testuser\nPATH=/mock/bin\n_CLAUDE_ENV_DELIMITER_',
  ),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../platform', () => ({
  buildEnvironment: () => ({ HOME: '/mock/home', USER: 'testuser' }),
  getDefaultShell: () => '/bin/zsh',
  isWindows: vi.fn(() => false),
}));

import { isWindows } from '../platform';
import {
  computeClaudeSessionKey,
  diffKeyParts,
} from '../socket/execution/claude-session/session-key';
import {
  buildClaudeEnv,
  buildOneShotClaudeLaunch,
  clearClaudeEnvCache,
  getBundledClaudeBinaryPath,
  getClaudeShellEnvironment,
} from './env';

describe('buildClaudeEnv', () => {
  afterEach(() => {
    clearClaudeEnvCache();
  });

  it('sets CLAUDE_CODE_ENABLE_TASKS to "true" by default', () => {
    const env = buildClaudeEnv();
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('true');
  });

  it('sets CLAUDE_CODE_ENABLE_TASKS to "true" when enableTasks is true', () => {
    const env = buildClaudeEnv({ enableTasks: true });
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('true');
  });

  it('sets CLAUDE_CODE_ENABLE_TASKS to "false" when enableTasks is false', () => {
    const env = buildClaudeEnv({ enableTasks: false });
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('false');
  });

  it('sets CLAUDE_CODE_ENABLE_TASKS to "true" when enableTasks is undefined', () => {
    const env = buildClaudeEnv({ enableTasks: undefined });
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('true');
  });

  it('always sets CLAUDE_CODE_ENTRYPOINT to "sdk-ts"', () => {
    const env = buildClaudeEnv();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
  });

  it('applies ghToken as GH_TOKEN', () => {
    const env = buildClaudeEnv({ ghToken: 'gh_test123' });
    expect(env.GH_TOKEN).toBe('gh_test123');
  });

  it('applies customEnv overrides', () => {
    const env = buildClaudeEnv({ customEnv: { MY_VAR: 'hello' } });
    expect(env.MY_VAR).toBe('hello');
  });

  it('deletes env vars when customEnv value is empty string', () => {
    const env = buildClaudeEnv({ customEnv: { HOME: '' } });
    expect(env.HOME).toBeUndefined();
  });

  it('keys a spawn built before the SDK writes its variables into process.env like one built after', () => {
    vi.stubEnv('CLAUDE_AGENT_SDK_VERSION', undefined);
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', undefined);
    const before = buildClaudeEnv();
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', '1'); // what importing the SDK does
    vi.stubEnv('CLAUDE_AGENT_SDK_VERSION', '0.3.186'); // what the SDK's first query() does
    const after = buildClaudeEnv();
    vi.unstubAllEnvs();

    expect(after).toEqual(before);
    const keyOf = (env: Record<string, string>) => computeClaudeSessionKey({ env }, undefined);
    expect(diffKeyParts(keyOf(before), keyOf(after))).toEqual([]);
  });
});

describe('getClaudeShellEnvironment caching', () => {
  beforeEach(() => {
    clearClaudeEnvCache();
    vi.mocked(execFileSync).mockClear();
    vi.mocked(isWindows).mockReturnValue(false);
  });
  afterEach(() => {
    clearClaudeEnvCache();
    // Restore the default so a Windows opt-in never leaks into a sibling describe.
    vi.mocked(isWindows).mockReturnValue(false);
  });

  it('reuses the cached shell env across buildClaudeEnv calls (one login-shell spawn)', () => {
    // Distinct returns per spawn so a cache hit is provable, not just a spawn count: a broken
    // cache would spawn twice and surface '/second/bin' on the second call.
    vi.mocked(execFileSync)
      .mockReturnValueOnce('_CLAUDE_ENV_DELIMITER_PATH=/first/bin\n_CLAUDE_ENV_DELIMITER_')
      .mockReturnValueOnce('_CLAUDE_ENV_DELIMITER_PATH=/second/bin\n_CLAUDE_ENV_DELIMITER_');

    const first = buildClaudeEnv();
    const second = buildClaudeEnv();

    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(second.PATH).toBe(first.PATH);
    expect(second.PATH).toBe('/first/bin');
  });

  it('re-spawns the shell after clearClaudeEnvCache', () => {
    buildClaudeEnv();
    clearClaudeEnvCache();
    buildClaudeEnv();

    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('caches the buildEnvironment fallback after a spawn failure so it does not re-spawn', () => {
    // A failed login shell is memoized like a success: the catch branch caches the fallback, so a
    // transient failure degrades the whole process (no automatic retry) until the cache is cleared.
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('shell spawn failed');
    });

    const first = getClaudeShellEnvironment();
    const second = getClaudeShellEnvironment();

    expect(first.HOME).toBe('/mock/home'); // served from the buildEnvironment fallback
    expect(execFileSync).toHaveBeenCalledTimes(1); // the failed spawn is not retried
    expect(second).toEqual(first);
  });

  it('returns a copy so a caller mutating the result cannot corrupt the cache', () => {
    const first = getClaudeShellEnvironment();
    first.PATH = 'CORRUPTED';

    const second = getClaudeShellEnvironment();

    expect(second.PATH).toBe('/mock/bin'); // cache is unaffected by the caller's mutation
  });

  it('derives the env from the platform provider on Windows without spawning a shell, and caches it', () => {
    vi.mocked(isWindows).mockReturnValue(true);

    const first = getClaudeShellEnvironment();
    getClaudeShellEnvironment();

    expect(execFileSync).not.toHaveBeenCalled(); // no interactive login shell on Windows
    expect(first.HOME).toBe('/mock/home');
  });
});

describe('getBundledClaudeBinaryPath', () => {
  it('returns the bundled claude path and memoizes the second call', () => {
    // Parity with codex's getBundledCodexBinaryPath memo test — claude routes through the same
    // shared getBundledBinaryPath helper since the refactor; this exercises the memo + happy path.
    const first = getBundledClaudeBinaryPath();
    expect(first.endsWith('claude')).toBe(true);
    expect(getBundledClaudeBinaryPath()).toBe(first);
  });
});

describe('buildOneShotClaudeLaunch', () => {
  // Covers the helper DIRECTLY. Callers commonly mock this module, so behaviour asserted only
  // through a consumer proves the mock, not the helper. What must hold: an inherited shell token
  // never survives, and the credential passed in always wins — otherwise a spawn silently
  // authenticates as an account the user did not choose. And the chosen token never sits in the
  // env the CLI's Bash commands and MCP servers inherit.
  const originalEnv = { ...process.env };

  afterEach(() => {
    clearClaudeEnvCache();
    process.env = { ...originalEnv };
  });

  it('strips an inherited shell token so it cannot override a passthrough credential', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-from-the-users-shell';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-from-the-users-shell';
    clearClaudeEnvCache();

    // Passthrough carries no token of its own — precisely when a stray shell value would win.
    const launch = buildOneShotClaudeLaunch({ token: null, isApiKey: false });

    expect(launch.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(launch.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(launch.spawnClaudeCodeProcess).toBeUndefined();
  });

  it("pins CLAUDE_SECURESTORAGE_CONFIG_DIR to '' so the CLI reads the canonical keychain login", () => {
    const { env } = buildOneShotClaudeLaunch({ token: null, isApiKey: false });
    // Strict equality: toBeFalsy() would also pass on `undefined`, which is the broken state —
    // the CLI branches on `!== undefined`, so an absent var re-enables the hashed service name.
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('');
  });

  it('delivers the SELECTED API key through the fd, not env, and drops the shell value', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-from-the-users-shell';
    clearClaudeEnvCache();

    const launch = buildOneShotClaudeLaunch({ token: 'sk-ant-api-chosen', isApiKey: true });

    expect(launch.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR).toBe('3');
    expect(JSON.stringify(launch.env)).not.toContain('sk-ant-api');
    expect(launch.spawnClaudeCodeProcess).toBeTypeOf('function');
  });

  it('routes a non-api-key credential to the OAuth fd', () => {
    const { env } = buildOneShotClaudeLaunch({ token: 'sk-ant-oat01-chosen', isApiKey: false });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe('3');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env).not.toHaveProperty('CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR');
  });
});
