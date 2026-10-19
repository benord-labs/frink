import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import electronViteConfig from '../../electron.vite.config';
import { initPreloadSentry } from './sentry';

const DSN = 'https://public@sentry.invalid/1';
const sentry = { init: vi.fn() };
const loadSdk = async () => sentry;

describe('initPreloadSentry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('initialises Sentry in production when a DSN is baked in', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('MAIN_VITE_SENTRY_DSN', DSN);

    await initPreloadSentry(loadSdk);

    expect(sentry.init).toHaveBeenCalledOnce();
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: DSN, defaultIntegrations: false }),
    );
  });

  it('routes preload events and breadcrumbs through the shared scrubber', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('MAIN_VITE_SENTRY_DSN', DSN);

    await initPreloadSentry(loadSdk);

    const [{ beforeSend, beforeBreadcrumb }] = sentry.init.mock.calls[0];
    expect(beforeSend({ extra: { prompt: 'secret' } })).toEqual({});
    expect(beforeBreadcrumb({ category: 'console', message: 'secret' })).toBeNull();
  });

  it('leaves Sentry off when no DSN is baked in', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('MAIN_VITE_SENTRY_DSN', '');

    await initPreloadSentry(loadSdk);

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('leaves Sentry off outside production', async () => {
    vi.stubEnv('PROD', false);
    vi.stubEnv('MAIN_VITE_SENTRY_DSN', DSN);

    await initPreloadSentry(loadSdk);

    expect(sentry.init).not.toHaveBeenCalled();
  });
});

// The preload build resolves the main DSN the same way the main build does (mode files, CI env)
// but sees no other main-only value.
describe('preload build env', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('inlines the main Sentry DSN and nothing else from MAIN_VITE_', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preload-env-'));
    writeFileSync(
      join(dir, '.env.production'),
      `MAIN_VITE_SENTRY_DSN=${DSN}\nMAIN_VITE_POSTHOG_KEY=phc_main_only\n`,
    );
    // Importing the config copies the checkout's .env into process.env, which outranks files.
    vi.stubEnv('MAIN_VITE_SENTRY_DSN', undefined);
    // SAFETY: the config is exported through `defineConfig(config as never)`; preload is a plain object.
    const { preload } = electronViteConfig as { preload: { envPrefix?: string[] } };

    const env = loadEnv('production', dir, preload.envPrefix);

    expect(env.MAIN_VITE_SENTRY_DSN).toBe(DSN);
    expect(env).not.toHaveProperty('MAIN_VITE_POSTHOG_KEY');
  });
});
