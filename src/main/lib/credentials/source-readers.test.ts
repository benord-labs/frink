import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

// Mock both `execFile` (called via promisify(execFile) in source-readers) and
// `execFileSync` (still used by detect.ts, which source-readers re-exports
// errors from). The keychain suite below only exercises the async `execFile`
// path — its mock signature is `(cmd, args, opts, callback)` because promisify
// expects the node-style callback form.
const execFileMock = vi.fn();
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    execFile: (
      cmd: string,
      args: string[],
      opts: object | undefined,
      callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      execFileMock(cmd, args, opts);
      // Defer to next microtask so promisify resolves like the real binding.
      queueMicrotask(() => {
        try {
          const stdout = execFileSyncMock(cmd, args, opts);
          callback(null, { stdout: typeof stdout === 'string' ? stdout : '', stderr: '' });
        } catch (err) {
          callback(err as Error);
        }
      });
    },
  };
});

import { probeClaudePassthroughSource } from './source-readers';

describe('probeClaudePassthroughSource', () => {
  let tempDir: string;
  let credsPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'frink-source-readers-'));
    credsPath = join(tempDir, 'credentials.json');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function fileUri(path: string): string {
    return `file://${path}`;
  }

  it('rejects unsupported URI schemes as malformed', async () => {
    const result = await probeClaudePassthroughSource('https://example.com/creds');
    expect(result).toMatchObject({ error: 'malformed' });
  });

  it('returns missing for a file source that does not exist', async () => {
    const result = await probeClaudePassthroughSource(fileUri('/does/not/exist/credentials.json'));
    expect(result).toMatchObject({ error: 'missing' });
  });

  it('returns ok for a file source that exists, without reading it', async () => {
    writeFileSync(credsPath, 'not even valid json');
    const result = await probeClaudePassthroughSource(fileUri(credsPath));
    // Contents are irrelevant — the `claude` binary parses its own store. Presence is the
    // whole contract, which is why a garbage file still probes ok.
    expect(result).toEqual({ ok: true });
  });

  it('returns missing for a darwin-keychain URI when not running on darwin', async () => {
    if (process.platform === 'darwin') {
      // On darwin we'd actually hit the keychain — this test only covers non-darwin behavior.
      expect(true).toBe(true);
      return;
    }
    const result = await probeClaudePassthroughSource(
      'darwin-keychain://Claude%20Code-credentials',
    );
    expect(result).toMatchObject({ error: 'missing' });
  });
});

describe('probeCodexPassthroughSource', () => {
  let codexHome: string;
  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    execFileMock.mockClear();
    execFileSyncMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('returns ok when auth.json exists, without reading it or shelling out', async () => {
    writeFileSync(join(codexHome, 'auth.json'), '{"tokens":{"id_token":"secret"}}');
    const { probeCodexPassthroughSource } = await import('./source-readers');
    await expect(probeCodexPassthroughSource()).resolves.toEqual({ ok: true });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns 'denied' (not 'missing') when auth.json cannot be checked", async () => {
    const locked = join(codexHome, 'locked');
    mkdirSync(locked, { mode: 0o000 });
    vi.stubEnv('CODEX_HOME', locked);
    const { probeCodexPassthroughSource } = await import('./source-readers');
    const result = await probeCodexPassthroughSource();
    chmodSync(locked, 0o700);
    expect(result).toMatchObject({ error: 'denied' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns missing when neither auth.json nor a keychain item exists', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('SecKeychainSearchCopyNext: not found'), { status: 44 });
    });
    const { probeCodexPassthroughSource } = await import('./source-readers');
    await expect(probeCodexPassthroughSource()).resolves.toMatchObject({ error: 'missing' });
  });
});

describe('probeClaudePassthroughSource — darwin keychain', () => {
  // Stage process.platform to 'darwin' for this whole describe so the keychain
  // branch executes and we can assert on the call shape + timeout handling
  // without touching the user's actual login keychain.
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('reads metadata only — never passes -w, and never returns the secret', async () => {
    execFileSyncMock.mockReturnValue('svce: "Claude Code-credentials"\nacct: "benji"');

    const result = await probeClaudePassthroughSource(
      'darwin-keychain://Claude%20Code-credentials',
    );

    const [cmd, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('security');
    expect(args).toEqual(['find-generic-password', '-s', 'Claude Code-credentials']);
    // `-w` is what prints the secret and consults the item's ACL. Frink must never ask for it
    // at chat time: the agent CLI reads the credential itself. Restoring `-w` here would
    // reintroduce the token into frink's memory and re-trigger TCC prompts mid-run.
    expect(args).not.toContain('-w');
    // The probe answers presence, not content — no secret is carried in the result.
    expect(result).toEqual({ ok: true });
  });

  it('passes a timeout so a locked keychain can never hang the executor', async () => {
    execFileSyncMock.mockReturnValue('svce: "Claude Code-credentials"');

    await probeClaudePassthroughSource('darwin-keychain://Claude%20Code-credentials');

    const [, , options] = execFileSyncMock.mock.calls[0] as [
      string,
      string[],
      { timeout?: number } | undefined,
    ];
    expect(options?.timeout).toBeGreaterThan(0);
    expect(options?.timeout).toBeLessThanOrEqual(5000);
  });

  it("returns error: 'denied' (not 'missing') on ETIMEDOUT", async () => {
    const err = Object.assign(new Error('execFile timeout'), { code: 'ETIMEDOUT' });
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    const result = await probeClaudePassthroughSource(
      'darwin-keychain://Claude%20Code-credentials',
    );

    // A locked keychain is functionally a denial, and the two need different user fixes
    // ("unlock / re-allow" vs "run claude auth login"), so they must not collapse.
    expect(result).toMatchObject({ error: 'denied' });
  });

  it("returns error: 'denied' when killed by signal (SIGTERM after timeout)", async () => {
    const err = Object.assign(new Error('Command failed'), { signal: 'SIGTERM', code: null });
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    const result = await probeClaudePassthroughSource(
      'darwin-keychain://Claude%20Code-credentials',
    );

    expect(result).toMatchObject({ error: 'denied' });
  });

  it("returns error: 'missing' when the entry is absent", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('SecKeychainSearchCopyNext: not found'), { status: 44 });
    });

    const result = await probeClaudePassthroughSource(
      'darwin-keychain://Claude%20Code-credentials',
    );

    expect(result).toMatchObject({ error: 'missing' });
  });
});

describe('probeClaudePassthroughSource — linux secret-tool', () => {
  // `secret-tool search` exits 0 whether or not anything matched, so the exit code alone
  // reports a login that isn't there — the probe would say `ok` and the failure would only
  // surface later as "Not logged in" from the spawned CLI. The attribute listing is the signal.
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it("returns 'missing' when search exits 0 with EMPTY output", async () => {
    execFileSyncMock.mockReturnValue('');

    const result = await probeClaudePassthroughSource('secret-tool://Claude%20Code/credentials');

    expect(result).toMatchObject({ error: 'missing' });
  });

  it("returns 'missing' when search exits 0 with only whitespace", async () => {
    execFileSyncMock.mockReturnValue('  \n  ');

    const result = await probeClaudePassthroughSource('secret-tool://Claude%20Code/credentials');

    expect(result).toMatchObject({ error: 'missing' });
  });

  it('returns ok when search lists a matching attribute set', async () => {
    execFileSyncMock.mockReturnValue(
      '[/org/freedesktop/secrets/collection/login/1]\nlabel = Claude',
    );

    const result = await probeClaudePassthroughSource('secret-tool://Claude%20Code/credentials');

    const [cmd, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('secret-tool');
    // `search`, never `lookup` — lookup prints the secret itself.
    expect(args[0]).toBe('search');
    expect(args).not.toContain('lookup');
    expect(result).toEqual({ ok: true });
  });

  // A timeout is the daemon being slow or the keyring locked, not a missing login. Reported
  // as 'missing' it would be persisted as a logout; 'denied' is the transient class.
  it("returns error: 'denied' (not 'missing') on ETIMEDOUT", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('execFile timeout'), { code: 'ETIMEDOUT' });
    });

    const result = await probeClaudePassthroughSource('secret-tool://Claude%20Code/credentials');

    expect(result).toMatchObject({ error: 'denied' });
  });
});
