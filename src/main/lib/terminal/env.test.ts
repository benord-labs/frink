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
