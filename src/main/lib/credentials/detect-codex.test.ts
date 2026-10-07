import type { ExecFileOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// File-based auth is exercised with REAL fixtures (a temp CODEX_HOME + a real auth.json),
// so node:fs is NOT mocked. Only the macOS keychain probe is mocked — there is no safe way
// to seed a real "Codex Auth" generic-password in a test. (electron-log is globally mocked
// in vitest.setup.ts, so no per-file mock is needed.) `securityMock` stands in for the
// `security` binary: return = exit 0, throw = non-zero exit / kill.
const securityMock = vi.fn();
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    execFile: (
      cmd: string,
      args: string[],
      opts: ExecFileOptions | undefined,
      callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      // Defer to next microtask so promisify resolves like the real binding.
      queueMicrotask(() => {
        try {
          securityMock(cmd, args, opts);
          callback(null, { stdout: '', stderr: '' });
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
});

import {
  codexKeyringAccount,
  detectCodexAccount,
  emailFromIdToken,
  parseCodexAuthBlob,
} from './detect-codex';

/** Build an unsigned JWT (header.payload.sig) carrying the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

describe('emailFromIdToken', () => {
  it('reads a top-level email claim', () => {
    expect(emailFromIdToken(makeJwt({ email: 'me@openai.com' }))).toBe('me@openai.com');
  });

  it('falls back to the OpenAI profile claim', () => {
    const jwt = makeJwt({ 'https://api.openai.com/profile': { email: 'prof@openai.com' } });
    expect(emailFromIdToken(jwt)).toBe('prof@openai.com');
  });

  it('returns undefined for non-string, malformed, or claimless input', () => {
    expect(emailFromIdToken(undefined)).toBeUndefined();
    expect(emailFromIdToken(42)).toBeUndefined();
    expect(emailFromIdToken('not.a.jwt')).toBeUndefined();
    expect(emailFromIdToken(makeJwt({ sub: 'x' }))).toBeUndefined();
  });
});

describe('parseCodexAuthBlob', () => {
  it('extracts email from an OAuth auth.json blob', () => {
    const raw = JSON.stringify({ tokens: { id_token: makeJwt({ email: 'u@openai.com' }) } });
    expect(parseCodexAuthBlob(raw)).toEqual({ email: 'u@openai.com', apiKey: false });
  });

  it('marks API-key auth with no email', () => {
    const raw = JSON.stringify({ OPENAI_API_KEY: 'sk-proj-abc' });
    expect(parseCodexAuthBlob(raw)).toEqual({ email: undefined, apiKey: true });
  });

  it('returns null when no usable credential is present', () => {
    expect(parseCodexAuthBlob('')).toBeNull();
    expect(parseCodexAuthBlob('   ')).toBeNull();
    expect(parseCodexAuthBlob('not json')).toBeNull();
    expect(parseCodexAuthBlob(JSON.stringify({ last_refresh: '2026-01-01' }))).toBeNull();
  });
});

describe('codexKeyringAccount', () => {
  const keyFor = (path: string) =>
    `cli|${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('hashes the canonical path when CODEX_HOME is reached through a symlink (sc-3811)', async () => {
    // codex-rs `compute_store_key` canonicalizes an existing home, so a dotfiles-style
    // symlinked ~/.codex must resolve to the same keychain account the CLI wrote.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'frink-codex-key-')));
    const real = join(dir, 'real-home');
    const link = join(dir, 'linked-home');
    mkdirSync(real);
    symlinkSync(real, link);

    expect(await codexKeyringAccount(link)).toBe(keyFor(real));
    expect(await codexKeyringAccount(real)).toBe(keyFor(real));
  });

  it('hashes the path as given when CODEX_HOME does not exist', async () => {
    // Matches codex-rs's `unwrap_or_else` branch: nothing to canonicalize.
    const missing = join(tmpdir(), 'frink-codex-key-does-not-exist', 'home');

    expect(await codexKeyringAccount(missing)).toBe(keyFor(missing));
  });
});

describe('detectCodexAccount', () => {
  const originalPlatform = process.platform;
  const originalCodexHome = process.env.CODEX_HOME;
  let tempHome: string | undefined;

  /** Point CODEX_HOME at a fresh temp dir; optionally seed a real auth.json fixture. */
  function setCodexHome(authJson?: string): string {
    tempHome = mkdtempSync(join(tmpdir(), 'frink-codex-'));
    process.env.CODEX_HOME = tempHome;
    if (authJson !== undefined) {
      writeFileSync(join(tempHome, 'auth.json'), authJson, { mode: 0o600 });
    }
    return tempHome;
  }

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  beforeEach(() => {
    securityMock.mockReset();
    execFileSyncMock.mockReset();
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
    setPlatform(originalPlatform);
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it('reads identity from CODEX_HOME/auth.json when present (token never returned)', async () => {
    setCodexHome(
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: makeJwt({ email: 'dev@openai.com' }),
          access_token: 'secret-access',
          refresh_token: 'secret-refresh',
        },
      }),
    );

    const result = await detectCodexAccount();

    expect(result.available).toBe(true);
    expect(result.email).toBe('dev@openai.com');
    expect(result.displayName).toBe('dev@openai.com');
    expect(result.sourcePath).toBe('codex-passthrough://local');
    // Defense-in-depth: the result object must never carry the token material.
    expect(JSON.stringify(result)).not.toContain('secret-access');
    expect(JSON.stringify(result)).not.toContain('secret-refresh');
  });

  it('honors a custom CODEX_HOME (never reading ~/.codex) and surfaces API-key auth', async () => {
    const home = setCodexHome(JSON.stringify({ OPENAI_API_KEY: 'sk-proj-xyz' }));
    expect(process.env.CODEX_HOME).toBe(home); // proves the temp home is honored, not overridden

    const result = await detectCodexAccount();

    expect(result.available).toBe(true);
    expect(result.displayName).toBe('OpenAI (API key)');
  });

  it('reports an unreadable hint when auth.json exists but carries no usable credential', async () => {
    // A present-but-stale auth.json (e.g. only a last_refresh stamp) parses to no
    // credential — the user must re-login, not be told "available".
    setCodexHome(JSON.stringify({ last_refresh: '2026-01-01' }));

    const result = await detectCodexAccount();

    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/re-run `codex login`/i);
  });

  it('returns a safe failure hint (no detail leak) when auth.json cannot be read', async () => {
    // auth.json present but unreadable (here: a directory where a file is expected →
    // EISDIR) must be caught and reported without leaking the error into the result.
    setCodexHome();
    mkdirSync(join(tempHome as string, 'auth.json'));

    const result = await detectCodexAccount();

    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/failed to read codex credentials/i);
    expect(JSON.stringify(result)).not.toMatch(/EISDIR|auth\.json/i);
  });

  it('confirms a keychain-stored login by presence, without reading the secret (sc-3811)', async () => {
    const home = setCodexHome(); // empty temp home → no auth.json on disk
    setPlatform('darwin');

    const result = await detectCodexAccount();

    expect(result).toEqual({
      available: true,
      displayName: 'OpenAI',
      sourcePath: 'codex-passthrough://local',
    });
    // Metadata only: `-w` would print the token and raise a prompt nobody can answer in time.
    expect(securityMock).toHaveBeenCalledTimes(1);
    expect(securityMock.mock.calls[0]?.[1]).toEqual([
      'find-generic-password',
      '-s',
      'Codex Auth',
      '-a',
      await codexKeyringAccount(home),
    ]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the probe times out', Object.assign(new Error('timed out'), { signal: 'SIGTERM' })],
    ['macOS refuses the read', Object.assign(new Error('denied'), { status: 36 })],
  ])('still reports the login as available when %s', async (_label, error) => {
    // A locked keychain says nothing about whether the login exists, so it must not
    // read as "logged out".
    setCodexHome();
    setPlatform('darwin');
    securityMock.mockImplementation(() => {
      throw error;
    });

    const result = await detectCodexAccount();

    expect(result.available).toBe(true);
    expect(result.email).toBeUndefined();
  });

  it('reports no login when the keychain item does not exist', async () => {
    setCodexHome();
    setPlatform('darwin');
    securityMock.mockImplementation(() => {
      throw Object.assign(new Error('SecKeychainSearchCopyNext: not found'), { status: 44 });
    });

    const result = await detectCodexAccount();

    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/codex login/i);
  });

  it('refuses a malformed auth.json even when a keychain login also exists, without probing it', async () => {
    // The file wins over the keychain: a stale file must not be papered over by a
    // keychain item that merely exists.
    setCodexHome(JSON.stringify({ last_refresh: '2026-01-01' }));
    setPlatform('darwin'); // securityMock's default (no throw) = keychain item present

    const result = await detectCodexAccount();

    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/re-run `codex login`/i);
    expect(securityMock).not.toHaveBeenCalled();
  });

  it('returns available=false with a login hint, and never shells out on non-macOS', async () => {
    setCodexHome(); // empty temp home → no auth.json
    setPlatform('linux');

    const result = await detectCodexAccount();

    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/codex login/i);
    // Linux without a file must not shell out to the macOS `security` tool.
    expect(securityMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
