import { describe, expect, it } from 'vitest';
import {
  AccountRows,
  FIXTURE_ACCOUNTS,
  runSmoke,
  type SmokeDeps,
  smokeFailures,
  smokePage,
  waitForPage,
  WAKE_TIMEOUT_MS,
  wakeFixtureChats,
} from './smoke-check';

const healthyAccounts = () => FIXTURE_ACCOUNTS.map((id) => ({ id, needs_reauth_at: null }));

/** A rig whose clock advances only through deps.sleep, so time-outs run instantly. */
function fakeRig(overrides: Partial<SmokeDeps> & { composer?: boolean } = {}) {
  let clock = 0;
  const calls: string[] = [];
  const page = {
    probe: async () => overrides.composer ?? true,
    close: () => calls.push('close'),
  };
  const deps: SmokeDeps = {
    connect: async () => page,
    booting: () => true,
    wake: () => ({ ok: true, output: '' }),
    readAccounts: healthyAccounts,
    readMainLog: () => '[info] booted\n',
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
  return { deps, calls };
}

describe('smokeFailures', () => {
  it('passes a healthy rig', () => {
    expect(
      smokeFailures({ accounts: healthyAccounts(), mainLog: 'ok\n', hasComposer: true }),
    ).toEqual([]);
  });

  it('names a fixture login the app flagged, in the db and in main.log', () => {
    const accounts = healthyAccounts();
    accounts[1] = { id: FIXTURE_ACCOUNTS[1], needs_reauth_at: 1_760_000_000 };
    const mainLog = `[warn] [credentials] Marked row ${FIXTURE_ACCOUNTS[1]} needs reauth: source probe: gone\n`;
    expect(smokeFailures({ accounts, mainLog, hasComposer: true })).toEqual([
      `fixture account ${FIXTURE_ACCOUNTS[1]} is flagged needs_reauth_at`,
      `main.log: [warn] [credentials] Marked row ${FIXTURE_ACCOUNTS[1]} needs reauth: source probe: gone`,
    ]);
  });

  it('fails when a fixture account was never seeded, the log is missing, or no composer showed', () => {
    expect(smokeFailures({ accounts: [], mainLog: null, hasComposer: false })).toEqual([
      ...FIXTURE_ACCOUNTS.map((id) => `fixture account ${id} is missing from agents.db`),
      'main.log was not written',
      'no chat composer on screen',
    ]);
  });
});

describe('waitForPage', () => {
  it('retries while the window is still loading, then connects', async () => {
    const errors = [
      'fetch failed',
      'no page target on :9223: ',
      'the page at "about:blank" has not loaded a renderer',
    ];
    const { deps } = fakeRig();
    const page = { probe: async () => true, close: () => {} };
    deps.connect = async () => {
      const next = errors.shift();
      if (next) throw new Error(next);
      return page;
    };
    await expect(waitForPage(deps, 90_000)).resolves.toBe(page);
  });

  it("fails at once when the window rendered a dev server instead of this checkout's bundle", async () => {
    const { deps } = fakeRig();
    let attempts = 0;
    deps.connect = async () => {
      attempts += 1;
      throw new Error(
        'expected the prebuilt out-qa renderer (file://) but the page is http://localhost:5173/',
      );
    };
    await expect(waitForPage(deps, 90_000)).rejects.toThrow(/localhost:5173/);
    expect(attempts).toBe(1);
  });

  it('stops waiting when boot.sh has exited, and when the deadline passes', async () => {
    const stillLoading = async () => {
      throw new Error('fetch failed');
    };
    const exited = fakeRig({ connect: stillLoading, booting: () => false });
    await expect(waitForPage(exited.deps, 90_000)).rejects.toThrow(/boot\.sh exited/);
    const slow = fakeRig({ connect: stillLoading });
    await expect(waitForPage(slow.deps, 5_000)).rejects.toThrow(/did not load within 5 s/);
  });
});

describe('runSmoke', () => {
  it('passes a healthy rig and always closes the page', async () => {
    const { deps, calls } = fakeRig();
    expect(await runSmoke(deps)).toEqual([]);
    expect(calls).toEqual(['close']);
  });

  it('reports a failed wake without running the checks that depend on it', async () => {
    const { deps, calls } = fakeRig({
      wake: () => ({ ok: false, output: 'boom\nsendMessage rejected\n' }),
    });
    expect(await runSmoke(deps)).toEqual(['wake-background-chats.ts failed: sendMessage rejected']);
    expect(calls).toEqual(['close']);
  });

  it('fails when no composer appears within the wait, as when a login card replaces it', async () => {
    const { deps } = fakeRig({ composer: false });
    expect(await runSmoke(deps)).toEqual(['no chat composer on screen']);
  });

  it('turns a connect failure into the run verdict instead of throwing', async () => {
    const { deps } = fakeRig({
      connect: async () => {
        throw new Error(
          'expected the prebuilt out-qa renderer (file://) but the page is http://localhost:5173/',
        );
      },
    });
    expect(await runSmoke(deps)).toEqual([
      'expected the prebuilt out-qa renderer (file://) but the page is http://localhost:5173/',
    ]);
  });
});

describe('wakeFixtureChats', () => {
  it('runs the wake script under a deadline and reports its exit', () => {
    const seen: Array<[string[], { timeout: number }]> = [];
    const result = wakeFixtureChats((command, options) => {
      seen.push([command, options]);
      return { exitCode: 0, stdout: 'woke 3 chats\n', stderr: '' };
    });
    expect(result).toEqual({ ok: true, output: 'woke 3 chats\n' });
    expect(seen[0][0][1]).toMatch(/wake-background-chats\.ts$/);
    expect(seen[0][1]).toEqual({ timeout: WAKE_TIMEOUT_MS });
  });

  it('turns a script that hung until the deadline into a failure, not a stuck smoke run', () => {
    const result = wakeFixtureChats(() => ({
      exitCode: null,
      exitedDueToTimeout: true,
      signalCode: 'SIGTERM',
      stdout: '',
      stderr: '',
    }));
    expect(result).toEqual({ ok: false, output: 'timed out after 60 s' });
  });

  it('names the signal when the script was killed rather than timed out', () => {
    const result = wakeFixtureChats(() => ({
      exitCode: null,
      signalCode: 'SIGKILL',
      stdout: '',
      stderr: '',
    }));
    expect(result).toEqual({ ok: false, output: 'killed by SIGKILL' });
  });

  it('passes a failed run through with its output', () => {
    const result = wakeFixtureChats(() => ({ exitCode: 1, stdout: '', stderr: 'tRPC rejected\n' }));
    expect(result).toEqual({ ok: false, output: 'tRPC rejected\n' });
  });
});

describe('AccountRows', () => {
  it('accepts the rows the credentials table returns', () => {
    const rows = [{ id: 'qa-fixture-account-1', needs_reauth_at: null }];
    expect(AccountRows.parse(rows)).toEqual(rows);
  });

  it('refuses a row whose shape drifted from the schema', () => {
    expect(() => AccountRows.parse([{ id: 7, needs_reauth_at: null }])).toThrow();
    expect(() => AccountRows.parse([{ id: 'a', needs_reauth_at: '2026-10-19' }])).toThrow();
  });
});

describe('smokePage', () => {
  it('answers true only for a literal true, and closes the underlying page', async () => {
    let closed = false;
    const answers = [true, 'true', 1, undefined];
    const page = smokePage({
      url: 'file:///repo/out-qa/renderer/index.html',
      call: async () => ({}),
      evaluate: async () => answers.shift(),
      close: () => {
        closed = true;
      },
    });
    expect([
      await page.probe('x'),
      await page.probe('x'),
      await page.probe('x'),
      await page.probe('x'),
    ]).toEqual([true, false, false, false]);
    page.close();
    expect(closed).toBe(true);
  });
});
