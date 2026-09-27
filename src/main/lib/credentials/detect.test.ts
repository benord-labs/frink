import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

import { _internal, detectClaudeAccount, sanitizeError } from './detect';

describe('detect.ts logging hygiene', () => {
  it('scrubs sk-ant-oat tokens out of plain Error messages', () => {
    const err = new Error('decrypt failed for token sk-ant-oat01-AbCdEf-123-XYZ');
    const out = sanitizeError(err);
    expect(out).not.toContain('sk-ant-oat01-AbCdEf-123-XYZ');
    expect(out).toContain('sk-ant-<redacted>');
  });

  it('scrubs sk-ant-api tokens out of plain Error messages', () => {
    const err = new Error('exec failed: sk-ant-api03-real-key-here returned 401');
    const out = sanitizeError(err);
    expect(out).not.toContain('sk-ant-api03-real-key-here');
    expect(out).toContain('sk-ant-<redacted>');
  });

  it('scrubs accessToken/refreshToken JSON fields', () => {
    const err = new Error(
      'parse failed: {"claudeAiOauth":{"accessToken":"sk-ant-oat01-XYZ","refreshToken":"rt-secret-zzz"}}',
    );
    const out = sanitizeError(err);
    expect(out).not.toContain('sk-ant-oat01-XYZ');
    expect(out).not.toContain('rt-secret-zzz');
    expect(out).toContain('"accessToken":"<redacted>"');
    expect(out).toContain('"refreshToken":"<redacted>"');
  });

  it('handles non-Error values without crashing', () => {
    expect(sanitizeError(null)).toBe('');
    expect(sanitizeError(undefined)).toBe('');
    expect(sanitizeError('plain string sk-ant-oat01-AbCdEf')).toContain('sk-ant-<redacted>');
    expect(sanitizeError({ raw: 'sk-ant-oat01-XYZ' })).toContain('sk-ant-<redacted>');
  });

  it('scrubTokens leaves non-token text untouched', () => {
    expect(_internal.scrubTokens('hello world')).toBe('hello world');
    expect(_internal.scrubTokens('error code 42 at line 5')).toBe('error code 42 at line 5');
  });

  it('darwinKeychainUri urlencodes service names with special characters', () => {
    const uri = _internal.darwinKeychainUri('Claude Code-credentials');
    expect(uri).toBe('darwin-keychain://Claude%20Code-credentials');
  });

  it('fileUri produces a parseable file:// URL', () => {
    const uri = _internal.fileUri('/Users/me/.claude/.credentials.json');
    expect(uri).toBe('file:///Users/me/.claude/.credentials.json');
  });
});

describe('detectClaudeAccount on linux — credentials file only', () => {
  // The CLI reads only ~/.claude/.credentials.json on Linux (decisions/claude-credential-
  // ownership-at-spawn); the fake prints a secret the way the real secret-tool does.
  const originalPlatform = process.platform;
  const LEAKED = 'sk-ant-oat01-LEAK';

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    execSyncMock.mockReset();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((cmd: string) =>
      cmd === 'secret-tool' ? `secret = ${LEAKED}\n` : '',
    );
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns available=false with a claude auth login hint when the file is missing, even if the keyring has a login', () => {
    existsSyncMock.mockReturnValue(false);

    const result = detectClaudeAccount();

    expect(result.available).toBe(false);
    expect(result.sourcePath).toBeUndefined();
    expect(result.hint).toMatch(/claude auth login/);
    expect(result.hint).toContain('~/.claude/.credentials.json');
    // Don't point users at a store the CLI can't read.
    expect(result.hint).not.toMatch(/keyring/i);
    expect(JSON.stringify(result)).not.toContain(LEAKED);
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('connects via the file:// source without spawning anything when the file exists', () => {
    existsSyncMock.mockImplementation((path: string) => path.endsWith('.credentials.json'));
    readFileSyncMock.mockReturnValue('');

    const result = detectClaudeAccount();

    expect(result.available).toBe(true);
    expect(result.sourcePath).toBe(_internal.fileUri(_internal.CLAUDE_CONFIG_FILE_LINUX));
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});

describe('detectClaudeAccount on macOS', () => {
  const originalPlatform = process.platform;
  const TCC_DENIED_ERROR = Object.assign(new Error('User interaction is not allowed'), {
    status: 36,
    stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.',
  });

  function isCanonicalProbe(args: unknown[]): boolean {
    return (
      Array.isArray(args) &&
      args.length >= 2 &&
      Array.isArray(args[1]) &&
      args[1].includes('find-generic-password') &&
      args[1].includes('Claude Code-credentials')
    );
  }

  function isWorkspaceDump(args: unknown[]): boolean {
    return (
      Array.isArray(args) &&
      args.length >= 2 &&
      Array.isArray(args[1]) &&
      args[1].includes('dump-keychain')
    );
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    execSyncMock.mockReset();
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('happy path: probes only the canonical entry, no picker, no dump-keychain', () => {
    // Mirrors t3code's "use whatever the CLI uses by default". One TCC prompt,
    // one row, no overwhelming picker of workspace-scoped Claude Code-credentials-* entries.
    execFileSyncMock.mockImplementation((...args: unknown[]) => {
      if (isCanonicalProbe(args)) return 'sk-ant-oat01-from-canonical';
      throw new Error(`unexpected execFileSync call: ${JSON.stringify(args)}`);
    });
    existsSyncMock.mockReturnValue(false); // no ~/.claude.json — that's fine

    const result = detectClaudeAccount();

    expect(result.available).toBe(true);
    // The canonical, login-scoped entry is the ONLY connectable source: the executor pins
    // CLAUDE_SECURESTORAGE_CONFIG_DIR='' so the spawned CLI reads exactly this service name.
    expect(result.sourcePath).toBe('darwin-keychain://Claude%20Code-credentials');

    // dump-keychain MUST NOT be called — the workspace-entry sweep is gone entirely.
    const dumpCalls = execFileSyncMock.mock.calls.filter(isWorkspaceDump);
    expect(dumpCalls).toHaveLength(0);
  });

  it("returns 'denied' (not 'available=true') when the canonical TCC prompt is denied", () => {
    // Edge-case Bug #A: previously, denying the canonical entry would cause
    // detectMacOS to fall through to discovering and probing every workspace
    // entry — each of which would TCC-prompt. The user gets a barrage of
    // prompts after a single denial. Post-fix: denial is propagated as
    // available=false with a hint, no workspace probes attempted.
    execFileSyncMock.mockImplementation((...args: unknown[]) => {
      if (isCanonicalProbe(args)) throw TCC_DENIED_ERROR;
      throw new Error(`unexpected execFileSync call: ${JSON.stringify(args)}`);
    });
    existsSyncMock.mockReturnValue(false);

    const result = detectClaudeAccount();

    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/denied|allow|permission/i);

    // Most importantly: no dump-keychain (which would precede TCC-prompting
    // every workspace entry).
    const dumpCalls = execFileSyncMock.mock.calls.filter(isWorkspaceDump);
    expect(dumpCalls).toHaveLength(0);

    // No workspace `find-generic-password` calls either.
    const probeCalls = execFileSyncMock.mock.calls.filter(
      (args) =>
        Array.isArray(args) &&
        Array.isArray(args[1]) &&
        args[1].includes('find-generic-password') &&
        !args[1].includes('Claude Code-credentials'),
    );
    expect(probeCalls).toHaveLength(0);
  });

  it('reports unavailable when the canonical entry is missing, ignoring workspace entries', () => {
    // A user with only workspace-scoped `Claude Code-credentials-<hash>` sub-credentials has
    // nothing frink can connect: the spawned CLI resolves the unsuffixed service name, so a
    // workspace entry would probe fine here and then fail at spawn as "Not logged in".
    // `claude auth login` is the only real fix, so say that instead of offering a dead source.
    const NOT_FOUND_ERROR = Object.assign(new Error('SecKeychainSearchCopyNext: not found'), {
      status: 44,
    });
    execFileSyncMock.mockImplementation((...args: unknown[]) => {
      if (isCanonicalProbe(args)) throw NOT_FOUND_ERROR;
      throw new Error(`unexpected execFileSync call: ${JSON.stringify(args)}`);
    });
    existsSyncMock.mockReturnValue(false);

    const result = detectClaudeAccount();

    expect(result.available).toBe(false);
    expect(result.sourcePath).toBeUndefined();
    expect(result.hint).toMatch(/claude auth login/i);
    // No dump-keychain, and no probe of anything but the canonical service.
    expect(execFileSyncMock.mock.calls.filter(isWorkspaceDump)).toHaveLength(0);
    expect(execFileSyncMock.mock.calls.every(isCanonicalProbe)).toBe(true);
  });
});
