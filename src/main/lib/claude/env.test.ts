import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  LoginShellEnvResolver,
  type ShellEnv,
  setLoginShellEnvResolver,
} from '../platform/login-shell-env';
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

/** Resolve the shared login-shell env to `env` from a fake shell — no real profile is sourced. */
async function resolveShellAs(env: ShellEnv): Promise<void> {
  const resolver = new LoginShellEnvResolver({
    spawnShell: async () => ({ ok: true, env }),
    extendPath: (p) => p ?? '',
  });
  setLoginShellEnvResolver(resolver);
  await resolver.resolve();
}

beforeEach(async () => {
  vi.stubEnv('PATH', '/usr/bin:/bin');
  await resolveShellAs({ HOME: '/mock/home', USER: 'testuser', PATH: '/mock/bin' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe('getClaudeShellEnvironment', () => {
  beforeEach(() => {
    vi.mocked(isWindows).mockReturnValue(false);
  });
  afterEach(() => {
    // Restore the default so a Windows opt-in never leaks into a sibling describe.
    vi.mocked(isWindows).mockReturnValue(false);
  });

  it('uses the platform fallback until the login shell has resolved, without pinning it', async () => {
    // A slow or failed shell at startup used to be memoized for the whole process, leaving every
    // later Claude spawn (and its npx MCP servers) on the fallback PATH.
    const resolver = new LoginShellEnvResolver({
      spawnShell: async () => ({ ok: true, env: { PATH: '/mock/bin' } }),
      extendPath: (p) => p ?? '',
    });
    setLoginShellEnvResolver(resolver);
    const before = getClaudeShellEnvironment();
    expect(before.HOME).toBe('/mock/home');
    expect(before.PATH).toBeUndefined();

    await resolver.resolve();
    expect(getClaudeShellEnvironment().PATH?.split(':')[0]).toBe('/mock/bin');
  });

  it('carries the login-shell PATH into buildClaudeEnv ahead of the launch PATH', () => {
    expect(buildClaudeEnv().PATH).toBe('/mock/bin:/usr/bin:/bin');
  });

  it('strips provider keys that would interfere with Claude auth resolution', async () => {
    await resolveShellAs({ PATH: '/mock/bin', OPENAI_API_KEY: 'sk-other' });

    expect(getClaudeShellEnvironment()).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('derives the env from the platform provider on Windows, ignoring any shell env', () => {
    vi.mocked(isWindows).mockReturnValue(true);

    const env = getClaudeShellEnvironment();

    expect(env.PATH).toBeUndefined(); // the resolved /mock/bin is not consulted
    expect(env.HOME).toBe('/mock/home');
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
