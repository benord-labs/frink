/** Resolver + missing-message tests for the codex binary locator. */

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import codexManifest from '../../../../../patches/codex/manifest.json';
import { captureMainMessage } from '../../sentry/init';

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));
vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false),
}));
vi.mock('../../claude/env', () => ({ getClaudeShellEnvironment: vi.fn(() => ({})) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/mock/app' } }));
vi.mock('../../sentry/init', () => ({ captureMainMessage: vi.fn() }));

const { resolveCodexBinary, clearCodexBinaryCache, getCodexCliMissingMessage } =
  await import('./codex-binary');

const CURRENT_STAMP = `${codexManifest.version}+frink.${codexManifest.patchSha256.slice(0, 12)}\n`;

describe('resolveCodexBinary', () => {
  beforeEach(() => {
    clearCodexBinaryCache();
    vi.stubEnv('PATH', '/usr/bin:/usr/local/bin');
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset().mockReturnValue(CURRENT_STAMP);
    vi.mocked(captureMainMessage).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prefers the bundled binary over a PATH lookup', () => {
    // Bundled-first: when resources/bin ships a codex, use it — no PATH walk needed.
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('/resources/bin/'));
    expect(resolveCodexBinary()).toMatch(/resources\/bin\/.+\/codex$/);
    expect(captureMainMessage).not.toHaveBeenCalled();
    expect(vi.mocked(readFileSync).mock.calls[0]?.[0]).toMatch(
      /resources\/bin\/.+\/CODEX_VERSION$/,
    );
  });

  it('never falls back to an unpatched PATH binary', () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === '/usr/local/bin/codex');
    expect(resolveCodexBinary()).toBeNull();
  });

  it('returns null when the binary is nowhere to be found', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveCodexBinary()).toBeNull();
    expect(getCodexCliMissingMessage()).toContain('Reinstall Frink');
  });

  it('rejects a bundled binary built from a different patch and says so', () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('/resources/bin/'));
    vi.mocked(readFileSync).mockReturnValue('rust-v0.149.0+frink.1\n');
    expect(resolveCodexBinary()).toBeNull();
    expect(getCodexCliMissingMessage()).toContain('Reinstall Frink');
    expect(captureMainMessage).toHaveBeenCalledOnce();
  });

  it('treats a bundled binary with no CODEX_VERSION stamp as an older build', () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('/resources/bin/'));
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(resolveCodexBinary()).toBeNull();
    expect(captureMainMessage).toHaveBeenCalledOnce();
  });

  it('fails closed when the bundled probe throws', () => {
    vi.mocked(existsSync).mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(resolveCodexBinary()).toBeNull();
  });

  it('caches the bundled probe', () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('/resources/bin/'));
    expect(resolveCodexBinary()).toMatch(/resources\/bin\/.+\/codex$/);
    const callsAfterFirst = vi.mocked(existsSync).mock.calls.length;
    expect(resolveCodexBinary()).toMatch(/resources\/bin\/.+\/codex$/);
    expect(vi.mocked(existsSync).mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('getCodexCliMissingMessage', () => {
  it('tells users to reinstall Frink, with no developer instructions', () => {
    clearCodexBinaryCache();
    const msg = getCodexCliMissingMessage();
    expect(msg).toContain('Reinstall Frink');
    expect(msg).not.toMatch(/codex:build|Developers|patch|binary/);
  });
});
