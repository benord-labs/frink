import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  init: vi.fn(),
  scopeSetContext: vi.fn(),
}));

vi.mock('@sentry/electron/main', () => ({
  additionalContextIntegration: vi.fn(() => ({})),
  captureException: vi.fn(),
  captureMessage: mocks.captureMessage,
  childProcessIntegration: vi.fn(() => ({})),
  electronBreadcrumbsIntegration: vi.fn(() => ({})),
  electronContextIntegration: vi.fn(() => ({})),
  init: mocks.init,
  onUncaughtExceptionIntegration: vi.fn(() => ({})),
  onUnhandledRejectionIntegration: vi.fn(() => ({})),
  sentryMinidumpIntegration: vi.fn(() => ({})),
  setContext: vi.fn(),
  withScope: vi.fn((callback: (scope: { setContext: typeof mocks.scopeSetContext }) => void) =>
    callback({ setContext: mocks.scopeSetContext }),
  ),
}));
vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => 'test-version'), isPackaged: true },
}));
vi.mock('electron-log', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../constants', () => ({ IS_DEV: false }));
vi.unmock('./init');

import { captureMainDiagnosticMessage, initSentry, tagNativeOomEvent } from './init';

describe('captureMainDiagnosticMessage', () => {
  beforeAll(() => {
    vi.stubEnv('MAIN_VITE_SENTRY_DSN', 'https://public@example.invalid/1');
    initSentry();
  });

  it('tags a native crash event that carries a Chromium OOM crash key', () => {
    const tagged = tagNativeOomEvent({
      type: undefined,
      platform: 'native',
      contexts: {
        electron: {
          'crashpad.process_type': 'renderer',
          'crashpad.electron.v8-oom.location': 'CALL_AND_RETRY_LAST',
        },
      },
      tags: { 'event.process': 'renderer' },
    });

    expect(tagged.tags).toEqual({
      'event.process': 'renderer',
      oom: 'confirmed',
      oom_evidence: 'crashpad_oom_key',
    });
    expect(
      tagNativeOomEvent({ type: undefined, contexts: { electron: { crashed_url: 'app://x' } } })
        .tags,
    ).toBeUndefined();
    expect(
      tagNativeOomEvent({
        type: undefined,
        platform: 'native',
        contexts: {
          electron: { 'crashpad.ptype': 'gpu-process', 'crashpad.page-allocator-mapped-size': '1' },
        },
      }).tags,
    ).toBeUndefined();
    expect(
      tagNativeOomEvent({
        type: undefined,
        platform: 'javascript',
        contexts: {
          electron: { 'crashpad.ptype': 'renderer', 'crashpad.page-allocator-mapped-size': '1' },
        },
      }).tags,
    ).toBeUndefined();
  });

  it('clears inherited runtime context when an incident has no snapshot', () => {
    captureMainDiagnosticMessage('previous session ended', 'error', { classification: 'unclean' });

    expect(mocks.scopeSetContext).toHaveBeenCalledWith('frink_runtime', null);
    expect(mocks.captureMessage).toHaveBeenCalledWith('previous session ended', {
      level: 'error',
      tags: { classification: 'unclean' },
    });
  });
});
