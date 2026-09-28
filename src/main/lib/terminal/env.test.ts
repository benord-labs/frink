import { afterEach, describe, expect, it, vi } from 'vitest';

// Detection is the platform module's job — terminal/env.ts only wraps it with a sync hot-path cache.
const detectShell = vi.fn(async () => '/detected/shell');
const detectLocale = vi.fn(async () => 'xx_XX.UTF-8');
const platformDefaultShell = vi.fn(() => '/platform/default');

vi.mock('../platform', () => ({
  getDefaultShell: platformDefaultShell,
  platform: { detectShell, detectLocale },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('terminal env consolidation (SC-84)', () => {
  it('getDefaultShell returns SHELL synchronously without triggering platform detection', async () => {
    vi.stubEnv('SHELL', '/usr/bin/fish');
    vi.resetModules();
    const { getDefaultShell } = await import('./env');

    expect(getDefaultShell()).toBe('/usr/bin/fish');
    expect(detectShell).not.toHaveBeenCalled();
  });

  it('getDefaultShell delegates background detection to the platform singleton when SHELL is unset', async () => {
    vi.stubEnv('SHELL', undefined);
    vi.resetModules();
    const { getDefaultShell } = await import('./env');

    // Sync path returns the platform fallback immediately, then fills the cache in the background.
    expect(getDefaultShell()).toBe('/platform/default');
    expect(detectShell).toHaveBeenCalledWith({ timeoutMs: 1000 });
  });

  it('buildTerminalEnv uses a UTF-8 LANG from the base env without platform locale detection', async () => {
    vi.stubEnv('LANG', 'fr_FR.UTF-8');
    vi.resetModules();
    const { buildTerminalEnv } = await import('./env');

    const env = buildTerminalEnv({ shell: '/bin/zsh', paneId: 'p1' });
    expect(env.LANG).toBe('fr_FR.UTF-8');
    expect(detectLocale).not.toHaveBeenCalled();
  });

  it('buildTerminalEnv delegates locale detection to the platform singleton when LANG lacks UTF-8', async () => {
    vi.stubEnv('LANG', undefined);
    vi.stubEnv('LC_ALL', undefined);
    vi.resetModules();
    const { buildTerminalEnv } = await import('./env');

    const env = buildTerminalEnv({ shell: '/bin/zsh', paneId: 'p1' });
    expect(env.LANG).toBe('en_US.UTF-8'); // immediate fallback while detection runs
    expect(detectLocale).toHaveBeenCalledWith({ timeoutMs: 1000 });
  });

  // Multi-pane: many panes spawn at once. The shared in-flight promise must collapse
  // concurrent detection into a single subprocess, not one per pane.
  it('getDefaultShell dedupes concurrent detection into a single platform call', async () => {
    vi.stubEnv('SHELL', undefined);
    vi.resetModules();
    const { getDefaultShell } = await import('./env');

    getDefaultShell();
    getDefaultShell();
    getDefaultShell();
    expect(detectShell).toHaveBeenCalledTimes(1);
  });

  it('buildTerminalEnv dedupes concurrent locale detection into a single platform call', async () => {
    vi.stubEnv('LANG', undefined);
    vi.stubEnv('LC_ALL', undefined);
    vi.resetModules();
    const { buildTerminalEnv } = await import('./env');

    buildTerminalEnv({ shell: '/bin/zsh', paneId: 'p1' });
    buildTerminalEnv({ shell: '/bin/zsh', paneId: 'p2' });
    expect(detectLocale).toHaveBeenCalledTimes(1);
  });

  // Once detection resolves, the cache must serve the *detected* value (not the fallback forever)
  // and must not re-spawn detection on subsequent calls.
  it('getDefaultShell returns the detected shell from cache after background detection resolves', async () => {
    vi.stubEnv('SHELL', undefined);
    vi.resetModules();
    const { getDefaultShell } = await import('./env');

    expect(getDefaultShell()).toBe('/platform/default'); // fallback kicks off detection
    await vi.waitFor(() => expect(getDefaultShell()).toBe('/detected/shell'));
    expect(detectShell).toHaveBeenCalledTimes(1);
  });
});

describe('buildSafeEnv', () => {
  it('keeps runtime vars and allowed prefixes but drops secrets and non-string values', async () => {
    const { buildSafeEnv } = await import('./env');
    const env = buildSafeEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        LC_ALL: 'en_GB.UTF-8',
        AGENTS_RUN_ID: 'r1',
        FRINK_FAKE_SECRET: 'host-secret',
        ANTHROPIC_API_KEY: 'sk-ant',
        GITHUB_TOKEN: 'ghp',
        UNDEFINED_VAR: undefined,
      },
      { platform: 'darwin' },
    );

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LC_ALL: 'en_GB.UTF-8',
      AGENTS_RUN_ID: 'r1',
    });
  });

  it('matches Windows keys case-insensitively so cmd.exe keeps Path/SystemRoot/ComSpec', async () => {
    const { buildSafeEnv } = await import('./env');
    const env = buildSafeEnv(
      {
        Path: 'C:\\Windows\\system32',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
        PATHEXT: '.COM;.EXE;.BAT',
        FRINK_FAKE_SECRET: 'host-secret',
      },
      { platform: 'win32' },
    );

    expect(Object.keys(env).sort()).toEqual(['ComSpec', 'PATHEXT', 'Path', 'SystemRoot']);
  });

  it('is case-sensitive on POSIX, so a lower-case lookalike of an allowed key is dropped', async () => {
    const { buildSafeEnv } = await import('./env');
    expect(buildSafeEnv({ path: '/tmp/evil', PATH: '/usr/bin' }, { platform: 'linux' })).toEqual({
      PATH: '/usr/bin',
    });
  });
});

describe('omitEnvKeys (child-process secret scrub)', () => {
  it('drops every denylisted credential, including the Claude fd pointers', async () => {
    const { CREDENTIAL_ENV_DENYLIST, omitEnvKeys } = await import('./env');
    const env = Object.fromEntries(CREDENTIAL_ENV_DENYLIST.map((key) => [key, 'secret']));

    const kept = omitEnvKeys({ ...env, PATH: '/usr/bin' }, CREDENTIAL_ENV_DENYLIST, {
      platform: 'darwin',
    });

    expect(kept).toEqual({ PATH: '/usr/bin' });
  });

  it('matches case-insensitively on Windows, where env names are', async () => {
    const { CREDENTIAL_ENV_DENYLIST, omitEnvKeys } = await import('./env');
    const env = { Github_Token: 'ghp', anthropic_api_key: 'sk', Path: 'C:\\bin' };

    expect(omitEnvKeys(env, CREDENTIAL_ENV_DENYLIST, { platform: 'win32' })).toEqual({
      Path: 'C:\\bin',
    });
  });

  it('keeps a same-named var with different case on POSIX, where names are case-sensitive', async () => {
    const { omitEnvKeys } = await import('./env');
    expect(omitEnvKeys({ github_token: 'x' }, ['GITHUB_TOKEN'], { platform: 'linux' })).toEqual({
      github_token: 'x',
    });
  });

  it('drops non-string values instead of passing `undefined` to a spawn', async () => {
    const { omitEnvKeys } = await import('./env');
    expect(omitEnvKeys({ A: 'a', B: undefined }, [], { platform: 'linux' })).toEqual({ A: 'a' });
  });

  it('buildSafeEnv already excludes the Claude fd pointers a CLI child inherits', async () => {
    const { buildSafeEnv } = await import('./env');
    const safe = buildSafeEnv(
      { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3', SECRET_X: 's' },
      { platform: 'darwin' },
    );
    expect(safe).toEqual({ PATH: '/usr/bin' });
  });
});
