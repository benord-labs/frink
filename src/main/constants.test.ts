import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('IS_DEV (qa/boot-from-build)', () => {
  it('is true when ELECTRON_RENDERER_URL is set (electron-vite dev / HMR)', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    vi.stubEnv('FRINK_CDP_PORT', undefined);
    const { IS_DEV } = await import('./constants');
    expect(IS_DEV).toBe(true);
  });

  it('is true when FRINK_CDP_PORT is set, even without a renderer dev-server URL — a QA run of a built bundle needs the same instance isolation (userData dir, CDP switch, mock keychain, frink-dev:// protocol) as a dev-server run', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);
    vi.stubEnv('FRINK_CDP_PORT', '9223');
    const { IS_DEV } = await import('./constants');
    expect(IS_DEV).toBe(true);
  });

  it('is false for a real production launch (neither var set)', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);
    vi.stubEnv('FRINK_CDP_PORT', undefined);
    const { IS_DEV } = await import('./constants');
    expect(IS_DEV).toBe(false);
  });
});

describe('PROTOCOL (single source of truth for index.ts and debug.ts)', () => {
  // debug.ts previously computed its own IS_DEV/PROTOCOL copy from ELECTRON_RENDERER_URL alone,
  // so it silently went stale the moment IS_DEV above grew the FRINK_CDP_PORT condition — its
  // debug-panel `protocolRegistered` check would look up the wrong scheme for a QA-built-bundle
  // run. Both index.ts and debug.ts now import PROTOCOL from here instead of recomputing it, so
  // this table is the only place that can drift.
  it('is frink-dev under the QA-built-bundle condition (FRINK_CDP_PORT only)', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);
    vi.stubEnv('FRINK_CDP_PORT', '9223');
    const { PROTOCOL, IS_DEV } = await import('./constants');
    expect(IS_DEV).toBe(true);
    expect(PROTOCOL).toBe('frink-dev');
  });

  it('is frink for a real production launch', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);
    vi.stubEnv('FRINK_CDP_PORT', undefined);
    const { PROTOCOL, IS_DEV } = await import('./constants');
    expect(IS_DEV).toBe(false);
    expect(PROTOCOL).toBe('frink');
  });
});
