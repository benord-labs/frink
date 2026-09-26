// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock('@sentry/electron/renderer', () => sentry);
vi.mock('../../App', () => ({ App: () => null }));
vi.mock('../code-editor/monaco/monaco-loader-config', () => ({}));

async function bootRenderer(): Promise<void> {
  vi.resetModules();
  await import('../../main');
}

describe('renderer boot', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    localStorage.setItem('preferences:custom-themes', '{not json');
    vi.stubEnv('RENDERER_VITE_SENTRY_DSN', 'https://public@sentry.invalid/1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('initialises Sentry in production before the stored theme is decoded and painted', async () => {
    vi.stubEnv('PROD', true);

    await bootRenderer();

    expect(sentry.init).toHaveBeenCalledOnce();
    // happy-dom loads no globals.css, so the boot paint fails reading the stock palette.
    expect(sentry.captureException.mock.calls.map(([, context]) => context)).toEqual([
      { tags: { surface: 'custom-themes-storage' } },
      { tags: { surface: 'theme-boot-or-handback-paint' } },
    ]);
    const [initOrder] = sentry.init.mock.invocationCallOrder;
    expect(Math.min(...sentry.captureException.mock.invocationCallOrder)).toBeGreaterThan(
      initOrder,
    );
  });

  it('leaves Sentry off outside production', async () => {
    vi.stubEnv('PROD', false);

    await bootRenderer();

    expect(sentry.init).not.toHaveBeenCalled();
  });
});
