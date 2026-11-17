import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureLoginShellEnv,
  FORCED_REFRESH_MIN_INTERVAL_MS,
  getLoginShellEnvSync,
  LoginShellEnvResolver,
  loginShellCandidates,
  REFRESH_MAX_AGE_MS,
  REFRESH_MIN_INTERVAL_MS,
  readLoginShellEnv,
  refreshLoginShellEnv,
  refreshLoginShellEnvInBackground,
  resolveLoginShellEnv,
  type ShellEnv,
  type ShellOutcome,
  setLoginShellEnvResolver,
  startLoginShellEnvResolve,
} from './login-shell-env';

const D = '_FRINK_ENV_DELIMITER_';
const scratch = mkdtempSync(join(tmpdir(), 'frink-login-shell-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in $SHELL: records its argv, then runs `body`. */
function fakeShell(name: string, body: string) {
  const path = join(scratch, name);
  const argsFile = `${path}.args`;
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n${body}\n`, { mode: 0o755 });
  return { path, argsFile };
}

const succeeds = (env: ShellEnv): (() => Promise<ShellOutcome>) =>
  vi.fn(async () => ({ ok: true as const, env }));
const fails = (): (() => Promise<ShellOutcome>) =>
  vi.fn(async () => ({
    ok: false as const,
    failure: {
      message: 'timed out',
      code: null,
      signal: 'SIGKILL',
      stderr: 'slow rc',
      timedOut: true,
    },
  }));
const extendPath = (p: string | undefined) => `/fallback/bin:${p ?? ''}`;

function install(spawnShell: () => Promise<ShellOutcome>): void {
  setLoginShellEnvResolver(new LoginShellEnvResolver({ spawnShell, extendPath }));
}

/** Resolve by really spawning these stand-in shells, in order — never the developer's own. */
function installAsking(...shells: string[]): void {
  install(() => readLoginShellEnv(shells));
}

const realPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.stubEnv('FRINK_TEST_SECRET', undefined);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  install(fails());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the real login-shell spawn', () => {
  // The fake $SHELL exports what a profile would, then runs the command Frink passed it (argv $2).
  const runsCommandWith = (exports: string) => `${exports}\neval "$2"`;

  it.skipIf(realPlatform === 'win32')(
    'runs the shell as an interactive login shell and reads the env it prints',
    async () => {
      const shell = fakeShell(
        'ok-shell',
        `echo 'motd noise'\n${runsCommandWith("export PATH='/Users/me/.bun/bin:/usr/bin:/bin' EQ='a=b'")}`,
      );
      installAsking(shell.path);

      const env = await resolveLoginShellEnv();

      expect(env?.PATH.split(':').slice(0, 3)).toEqual(['/Users/me/.bun/bin', '/usr/bin', '/bin']);
      expect(env?.EQ).toBe('a=b');
      // -i matters: bun and nvm add their PATH lines to .zshrc, which `-lc` alone never reads.
      expect(readFileSync(shell.argsFile, 'utf8').split('\n')[0]).toBe('-ilc');
    },
  );

  it.skipIf(realPlatform === 'win32')(
    'keeps values that hold a delimiter-like token or a newline intact, and cannot be fooled by them',
    async () => {
      const shell = fakeShell(
        'tricky-shell',
        runsCommandWith(
          [
            "export PATH='/real/bin:/usr/bin:/bin'",
            "export LOOKS_LIKE='x_FRINK_ENV_DELIMITER_y'",
            "export MULTI='line one\nPATH=/evil/bin'",
            `export COLOR="$(printf '\\033[31mred\\033[0m')"`,
          ].join('\n'),
        ),
      );
      installAsking(shell.path);

      const env = await resolveLoginShellEnv();

      expect(env?.PATH.startsWith('/real/bin:')).toBe(true);
      expect(env?.LOOKS_LIKE).toBe('x_FRINK_ENV_DELIMITER_y');
      expect(env?.MULTI).toBe('line one\nPATH=/evil/bin');
      expect(env?.COLOR).toBe('\u001b[31mred\u001b[0m');
    },
  );

  it.skipIf(realPlatform === 'win32')(
    'reports a failing shell as no env, leaving PATH alone',
    async () => {
      installAsking(fakeShell('bad-shell', "echo 'zshrc: parse error' >&2; exit 1").path);

      expect(await resolveLoginShellEnv()).toBeNull();
      expect(process.env.PATH).toBe('/usr/bin:/bin');
    },
  );

  it.skipIf(realPlatform === 'win32')(
    'treats output with no env section as a failure',
    async () => {
      installAsking(fakeShell('silent-shell', "echo 'HOME=/Users/me'").path);

      expect(await resolveLoginShellEnv()).toBeNull();
    },
  );
});

describe('choosing which shell to ask', () => {
  const runsCommand = (exports: string) => `${exports}\neval "$2"`;

  it('asks $SHELL, then the account shell, then the stock shell, each once', () => {
    expect(loginShellCandidates('/opt/homebrew/bin/fish', '/bin/zsh', 'darwin')).toEqual([
      '/opt/homebrew/bin/fish',
      '/bin/zsh',
    ]);
    // A GUI launch can arrive with no $SHELL at all.
    expect(loginShellCandidates(undefined, null, 'darwin')).toEqual(['/bin/zsh']);
    expect(loginShellCandidates('  ', '/bin/zsh', 'linux')).toEqual(['/bin/zsh', '/bin/bash']);
  });

  it('still offers the stock shell when $SHELL is set but unusable', () => {
    // The stock shell must not be derived from $SHELL, or a bad $SHELL is the only candidate.
    expect(loginShellCandidates('/gone/shell', '/gone/shell', 'darwin')).toEqual([
      '/gone/shell',
      '/bin/zsh',
    ]);
    expect(loginShellCandidates('/gone/shell', null, 'linux')).toEqual([
      '/gone/shell',
      '/bin/bash',
    ]);
  });

  it.skipIf(realPlatform === 'win32')(
    'falls through a shell that is missing or errors to the next one that answers',
    async () => {
      const broken = fakeShell('broken-shell', "echo 'bad option: -i' >&2; exit 2");
      const working = fakeShell('working-shell', runsCommand("export PATH='/second/bin:/usr/bin'"));
      installAsking(join(scratch, 'no-such-shell'), broken.path, working.path);

      const env = await resolveLoginShellEnv();

      expect(env?.PATH.split(':')[0]).toBe('/second/bin');
      expect(readFileSync(broken.argsFile, 'utf8').split('\n')[0]).toBe('-ilc');
    },
  );

  it.skipIf(realPlatform === 'win32')(
    'does not ask another shell after a timeout: a slow profile would be waited on again',
    async () => {
      const slow = fakeShell('slow-shell', 'exec sleep 5');
      const next = fakeShell('never-asked-shell', runsCommand("export PATH='/next/bin'"));
      install(() => readLoginShellEnv([slow.path, next.path], 200));

      expect(await resolveLoginShellEnv()).toBeNull();
      expect(() => readFileSync(next.argsFile, 'utf8')).toThrow();
    },
  );

  it.skipIf(realPlatform === 'win32')(
    'does ask the next shell when one is killed by something other than the timeout',
    async () => {
      const killed = fakeShell('killed-shell', 'kill -9 $$');
      const next = fakeShell('asked-after-kill', runsCommand("export PATH='/next/bin:/usr/bin'"));
      installAsking(killed.path, next.path);

      expect((await resolveLoginShellEnv())?.PATH.split(':')[0]).toBe('/next/bin');
    },
  );
});

describe('the SSH agent socket', () => {
  it('adopts the socket the shell profile exports, replacing the launch one', async () => {
    // 1Password / gpg-agent users export SSH_AUTH_SOCK in their profile; a Dock launch has the
    // system agent's socket instead, so `git push` over SSH fails only from the app.
    vi.stubEnv('SSH_AUTH_SOCK', '/private/tmp/com.apple.launchd.x/Listeners');
    install(succeeds({ PATH: '/shell/bin', SSH_AUTH_SOCK: '/Users/me/.1password/agent.sock' }));

    await resolveLoginShellEnv();

    expect(process.env.SSH_AUTH_SOCK).toBe('/Users/me/.1password/agent.sock');
  });

  it('leaves the launch socket alone when the profile sets none', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/private/tmp/com.apple.launchd.x/Listeners');
    install(succeeds({ PATH: '/shell/bin' }));

    await resolveLoginShellEnv();

    expect(process.env.SSH_AUTH_SOCK).toBe('/private/tmp/com.apple.launchd.x/Listeners');
  });
});

describe('resolveLoginShellEnv', () => {
  it('puts the shell PATH — and only PATH — on process.env', async () => {
    install(succeeds({ PATH: '/shell/bin:/usr/bin', FRINK_TEST_SECRET: 'hunter2' }));

    await resolveLoginShellEnv();

    expect(process.env.PATH).toBe('/shell/bin:/usr/bin:/bin');
    expect(process.env.FRINK_TEST_SECRET).toBeUndefined();
  });

  it('keeps PATH entries the launch environment had that the shell lacks, after the shell ones', async () => {
    // Launched from a terminal with direnv / an activated venv, or `bun run dev` adding
    // node_modules/.bin: replacing PATH outright would break what works today.
    vi.stubEnv('PATH', '/project/.venv/bin:/usr/bin:/bin');
    install(succeeds({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' }));

    await resolveLoginShellEnv();

    const merged = '/opt/homebrew/bin:/usr/bin:/bin:/project/.venv/bin';
    expect(process.env.PATH).toBe(merged);
    // Readers that take PATH from the resolved env (Claude, git) must keep the venv too.
    expect(getLoginShellEnvSync()?.PATH).toBe(merged);
  });

  it('spawns one shell for concurrent callers and none once resolved', async () => {
    const spawnShell = succeeds({ PATH: '/shell/bin' });
    install(spawnShell);

    const [a, b] = await Promise.all([resolveLoginShellEnv(), resolveLoginShellEnv()]);
    await resolveLoginShellEnv();

    expect(a).toEqual(b);
    expect(spawnShell).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed attempt: a later attempt succeeds', async () => {
    vi.useFakeTimers();
    const spawnShell = vi
      .fn<() => Promise<ShellOutcome>>()
      .mockImplementationOnce(fails())
      .mockImplementationOnce(succeeds({ PATH: '/shell/bin' }));
    install(spawnShell);

    expect(await resolveLoginShellEnv()).toBeNull();
    expect(getLoginShellEnvSync()).toBeNull();
    expect(process.env.PATH).toBe('/usr/bin:/bin');

    // Inside the cooldown an on-demand caller gets the fallback at once instead of waiting out
    // another shell timeout.
    expect(await resolveLoginShellEnv()).toBeNull();
    expect(spawnShell).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    expect((await resolveLoginShellEnv())?.PATH).toBe('/shell/bin:/usr/bin:/bin');
    expect(getLoginShellEnvSync()?.PATH).toBe('/shell/bin:/usr/bin:/bin');
  });

  it('gives a long-lived spawn a fresh attempt during the cooldown instead of the fallback', async () => {
    // A Claude session or Codex server started in the cooldown keeps its PATH for its whole life.
    const spawnShell = vi
      .fn<() => Promise<ShellOutcome>>()
      .mockImplementationOnce(fails())
      .mockImplementationOnce(succeeds({ PATH: '/shell/bin' }));
    install(spawnShell);
    expect(await resolveLoginShellEnv()).toBeNull();

    await ensureLoginShellEnv();

    expect(spawnShell).toHaveBeenCalledTimes(2);
    expect(getLoginShellEnvSync()?.PATH.split(':')[0]).toBe('/shell/bin');
  });

  it('makes its own fresh attempt when the startup attempt it joined fails', async () => {
    // The first Claude session is usually built while the startup resolve is still running.
    let failStartup: () => void = () => {};
    const spawnShell = vi
      .fn<() => Promise<ShellOutcome>>()
      .mockImplementationOnce(
        () =>
          new Promise<ShellOutcome>((resolve) => {
            failStartup = () =>
              resolve({
                ok: false,
                failure: {
                  message: 'slow',
                  code: null,
                  signal: 'SIGKILL',
                  stderr: '',
                  timedOut: true,
                },
              });
          }),
      )
      .mockImplementationOnce(succeeds({ PATH: '/shell/bin' }));
    install(spawnShell);
    startLoginShellEnvResolve();

    const session = ensureLoginShellEnv();
    failStartup();
    await session;

    expect(spawnShell).toHaveBeenCalledTimes(2);
    expect(getLoginShellEnvSync()?.PATH.split(':')[0]).toBe('/shell/bin');
  });

  it('stops forcing fresh attempts once the shell has failed repeatedly', async () => {
    // A broken profile must not cost every session start another shell timeout.
    const spawnShell = vi.fn(fails());
    install(spawnShell);
    for (let i = 0; i < 4; i++) await ensureLoginShellEnv();
    expect(spawnShell).toHaveBeenCalledTimes(4);

    await ensureLoginShellEnv();

    expect(spawnShell).toHaveBeenCalledTimes(4);
  });

  it('never spawns a shell on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const spawnShell = succeeds({ PATH: '/shell/bin' });
    install(spawnShell);

    expect(await resolveLoginShellEnv()).toBeNull();
    startLoginShellEnvResolve();

    expect(spawnShell).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });
});

describe('getLoginShellEnvSync', () => {
  it('never spawns, and hands out copies of the resolved env', async () => {
    const spawnShell = succeeds({ PATH: '/shell/bin' });
    install(spawnShell);
    expect(getLoginShellEnvSync()).toBeNull();
    expect(spawnShell).not.toHaveBeenCalled();

    await ensureLoginShellEnv();
    const first = getLoginShellEnvSync();
    if (first) first.PATH = 'CORRUPTED';

    expect(getLoginShellEnvSync()?.PATH).toBe('/shell/bin:/usr/bin:/bin');
  });
});

describe('startLoginShellEnvResolve', () => {
  it('extends PATH at once, then swaps in the shell PATH without blocking the caller', async () => {
    let finish: () => void = () => {};
    install(
      () =>
        new Promise<ShellOutcome>((resolve) => {
          finish = () => resolve({ ok: true, env: { PATH: '/shell/bin' } });
        }),
    );

    startLoginShellEnvResolve();

    // Returned while the shell is still running: early spawns already see the fallback dirs.
    expect(process.env.PATH).toBe('/fallback/bin:/usr/bin:/bin');
    expect(getLoginShellEnvSync()).toBeNull();

    finish();
    await ensureLoginShellEnv();
    expect(process.env.PATH).toBe('/shell/bin:/fallback/bin:/usr/bin:/bin');
  });

  it('retries in the background after a failed startup attempt', async () => {
    vi.useFakeTimers();
    const spawnShell = vi
      .fn<() => Promise<ShellOutcome>>()
      .mockImplementationOnce(fails())
      .mockImplementationOnce(succeeds({ PATH: '/shell/bin' }));
    install(spawnShell);

    startLoginShellEnvResolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(getLoginShellEnvSync()).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(spawnShell).toHaveBeenCalledTimes(2);
    expect(process.env.PATH?.split(':')[0]).toBe('/shell/bin');
  });

  it('stops retrying after the last scheduled attempt', async () => {
    vi.useFakeTimers();
    const spawnShell = vi.fn(fails());
    install(spawnShell);

    startLoginShellEnvResolve();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // The startup attempt plus one retry per delay (5s, 30s, 2min), then no more.
    expect(spawnShell).toHaveBeenCalledTimes(4);
  });
});

describe('refreshing the resolved environment (sc-4772)', () => {
  /** A fake shell whose profile the test edits between spawns, as a user would mid-session. */
  function editableProfile(env: ShellEnv, socketExists?: (path: string) => boolean) {
    const profile = { env };
    const spawnShell = vi.fn(async (): Promise<ShellOutcome> => ({
      ok: true,
      env: { ...profile.env },
    }));
    setLoginShellEnvResolver(new LoginShellEnvResolver({ spawnShell, extendPath, socketExists }));
    return { profile, spawnShell };
  }

  it('serves a stale env at once and refreshes it once in the background', async () => {
    vi.useFakeTimers();
    let answer: (outcome: ShellOutcome) => void = () => {};
    const spawnShell = vi
      .fn<() => Promise<ShellOutcome>>()
      .mockImplementationOnce(succeeds({ PATH: '/shell/bin' }))
      .mockImplementationOnce(
        () =>
          new Promise<ShellOutcome>((resolve) => {
            answer = resolve;
          }),
      );
    install(spawnShell);
    await resolveLoginShellEnv();
    vi.advanceTimersByTime(REFRESH_MAX_AGE_MS);

    // The refresh is still pending: no caller may wait on it while an env exists.
    expect((await resolveLoginShellEnv())?.PATH).toBe('/shell/bin:/usr/bin:/bin');
    await ensureLoginShellEnv();
    expect(spawnShell).toHaveBeenCalledTimes(2);

    answer({ ok: true, env: { PATH: '/new/bin:/shell/bin' } });
    await vi.advanceTimersByTimeAsync(0);

    const refreshed = '/new/bin:/shell/bin:/usr/bin:/bin';
    expect(process.env.PATH).toBe(refreshed);
    expect(getLoginShellEnvSync()?.PATH).toBe(refreshed);
    expect((await resolveLoginShellEnv())?.PATH).toBe(refreshed);
    expect(spawnShell).toHaveBeenCalledTimes(2);
  });

  it('does not re-read a freshly resolved env', async () => {
    vi.useFakeTimers();
    const { spawnShell } = editableProfile({ PATH: '/shell/bin' });
    await resolveLoginShellEnv();

    for (let i = 0; i < 5; i++) await ensureLoginShellEnv();
    expect(spawnShell).toHaveBeenCalledTimes(1);
  });

  it('refreshes on focus at most once a minute, and never on Windows', async () => {
    vi.useFakeTimers();
    const { spawnShell } = editableProfile({ PATH: '/shell/bin' });
    await resolveLoginShellEnv();
    vi.advanceTimersByTime(REFRESH_MIN_INTERVAL_MS);

    for (let i = 0; i < 5; i++) {
      refreshLoginShellEnvInBackground();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(spawnShell).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(REFRESH_MIN_INTERVAL_MS);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    refreshLoginShellEnvInBackground();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnShell).toHaveBeenCalledTimes(2);
  });

  it('joins the startup resolve when the first window gains focus during it', async () => {
    // The first window's focus fires at launch, while the startup shell is still loading.
    vi.useFakeTimers();
    let answer: (outcome: ShellOutcome) => void = () => {};
    const spawnShell = vi.fn(
      () =>
        new Promise<ShellOutcome>((resolve) => {
          answer = resolve;
        }),
    );
    install(spawnShell);

    startLoginShellEnvResolve();
    refreshLoginShellEnvInBackground();
    const forced = refreshLoginShellEnv();
    answer({ ok: true, env: { PATH: '/shell/bin' } });

    // start() extended the launch PATH first; the shell's entries go ahead of it.
    expect((await forced)?.PATH).toBe('/shell/bin:/fallback/bin:/usr/bin:/bin');
    expect(spawnShell).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good env when a refresh fails, and backs off before the next', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SSH_AUTH_SOCK', '/agent.sock');
    const spawnShell = vi
      .fn<() => Promise<ShellOutcome>>()
      .mockImplementationOnce(succeeds({ PATH: '/shell/bin' }))
      .mockImplementation(fails());
    install(spawnShell);
    const good = await resolveLoginShellEnv();
    vi.advanceTimersByTime(REFRESH_MAX_AGE_MS);

    await resolveLoginShellEnv();
    await vi.advanceTimersByTimeAsync(0);

    expect(spawnShell).toHaveBeenCalledTimes(2);
    expect(getLoginShellEnvSync()).toEqual(good);
    expect(process.env.PATH).toBe('/shell/bin:/usr/bin:/bin');
    expect(process.env.SSH_AUTH_SOCK).toBe('/agent.sock');
    // A failed refresh is no failure to resolve: long-lived spawns still get the good env at once.
    expect(await refreshLoginShellEnv()).toEqual(good);
    await ensureLoginShellEnv();
    expect(spawnShell).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(REFRESH_MIN_INTERVAL_MS);
    await resolveLoginShellEnv();
    expect(spawnShell).toHaveBeenCalledTimes(3);
  });

  it('rebuilds PATH from the launch PATH: no growth, and removed entries drop out', async () => {
    vi.useFakeTimers();
    vi.stubEnv('PATH', '/venv/bin:/usr/bin');
    const { profile } = editableProfile({ PATH: '/old/bin:/usr/bin' });
    await resolveLoginShellEnv();
    expect(process.env.PATH).toBe('/old/bin:/usr/bin:/venv/bin');

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_INTERVAL_MS);
      await refreshLoginShellEnv();
    }
    expect(process.env.PATH).toBe('/old/bin:/usr/bin:/venv/bin');

    profile.env = { PATH: '/usr/bin' };
    vi.advanceTimersByTime(FORCED_REFRESH_MIN_INTERVAL_MS);
    await refreshLoginShellEnv();

    // The launch-only venv entry stays, after the shell's.
    expect(process.env.PATH).toBe('/usr/bin:/venv/bin');
    expect(getLoginShellEnvSync()?.PATH).toBe('/usr/bin:/venv/bin');
  });

  it('keeps the env as it was when only per-shell values change', async () => {
    // atuin and starship export a fresh value in every interactive shell; a changed env would
    // recreate every warm Claude session keyed on it.
    vi.useFakeTimers();
    const { profile, spawnShell } = editableProfile({ PATH: '/shell/bin', ATUIN_SESSION: 'a' });
    const before = await resolveLoginShellEnv();

    profile.env = { PATH: '/shell/bin', ATUIN_SESSION: 'b' };
    vi.advanceTimersByTime(FORCED_REFRESH_MIN_INTERVAL_MS);
    await refreshLoginShellEnv();

    expect(spawnShell).toHaveBeenCalledTimes(2);
    expect(getLoginShellEnvSync()).toEqual(before);
  });

  it('keeps the current agent socket on refresh until it is gone', async () => {
    // An `eval $(ssh-agent)` profile starts a fresh, keyless agent on every spawn.
    vi.useFakeTimers();
    let alive = true;
    const { profile } = editableProfile(
      { PATH: '/shell/bin', SSH_AUTH_SOCK: '/agent/one' },
      () => alive,
    );
    await resolveLoginShellEnv();
    expect(process.env.SSH_AUTH_SOCK).toBe('/agent/one');

    profile.env = { PATH: '/shell/bin', SSH_AUTH_SOCK: '/agent/two' };
    vi.advanceTimersByTime(FORCED_REFRESH_MIN_INTERVAL_MS);
    await refreshLoginShellEnv();
    expect(process.env.SSH_AUTH_SOCK).toBe('/agent/one');
    expect(getLoginShellEnvSync()?.SSH_AUTH_SOCK).toBe('/agent/one');

    alive = false;
    vi.advanceTimersByTime(FORCED_REFRESH_MIN_INTERVAL_MS);
    await refreshLoginShellEnv();
    expect(process.env.SSH_AUTH_SOCK).toBe('/agent/two');
    expect(getLoginShellEnvSync()?.SSH_AUTH_SOCK).toBe('/agent/two');
  });

  it('shares one forced refresh between concurrent callers and throttles the next', async () => {
    vi.useFakeTimers();
    const { profile, spawnShell } = editableProfile({ PATH: '/shell/bin' });
    await resolveLoginShellEnv();
    profile.env = { PATH: '/new/bin' };
    vi.advanceTimersByTime(FORCED_REFRESH_MIN_INTERVAL_MS);

    const [a, b] = await Promise.all([refreshLoginShellEnv(), refreshLoginShellEnv()]);
    expect(a?.PATH).toBe('/new/bin:/usr/bin:/bin');
    expect(b).toEqual(a);
    await refreshLoginShellEnv();
    expect(spawnShell).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(FORCED_REFRESH_MIN_INTERVAL_MS);
    await refreshLoginShellEnv();
    expect(spawnShell).toHaveBeenCalledTimes(3);
  });
});
