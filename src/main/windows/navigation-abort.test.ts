import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ isPackaged: true }));
const abortMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const releaseLiveMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
  },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
const captureMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/sentry', () => ({ captureContained: captureMock }));
vi.mock('../lib/socket/executor', () => ({ abortActiveExecutionsForWebContents: abortMock }));
vi.mock('../lib/socket/streaming/execution-registry', () => ({
  releaseExecutionOwnershipForWebContents: releaseMock,
}));
vi.mock('../lib/socket/streaming/live-stream', () => ({
  releaseLiveStreamOwnershipForWebContents: releaseLiveMock,
}));

import {
  attachAgentAbortOnRendererLifecycle,
  shouldAbortAgentsOnNavigation,
} from './navigation-abort';

const PACKAGED = true;
const DEV = false;

describe('shouldAbortAgentsOnNavigation', () => {
  it('returns false for same-document navigation (hash change, scroll)', () => {
    expect(
      shouldAbortAgentsOnNavigation(
        {
          isSameDocument: true,
          isMainFrame: true,
          frame: null,
        },
        PACKAGED,
      ),
    ).toBe(false);
  });

  it('returns false for same-document navigation even when isMainFrame is false', () => {
    expect(
      shouldAbortAgentsOnNavigation(
        {
          isSameDocument: true,
          isMainFrame: false,
          frame: null,
        },
        PACKAGED,
      ),
    ).toBe(false);
  });

  it('returns true for main-frame full-document navigation (cmd+shift+r)', () => {
    expect(
      shouldAbortAgentsOnNavigation(
        {
          isSameDocument: false,
          isMainFrame: true,
          frame: null,
        },
        PACKAGED,
      ),
    ).toBe(true);
  });

  it('returns true when frame info is missing (defensive default)', () => {
    expect(
      shouldAbortAgentsOnNavigation({ isSameDocument: false, isMainFrame: true }, PACKAGED),
    ).toBe(true);
  });

  // PDF viewer / iframe navigation: `did-start-navigation` fires with isMainFrame: false.
  // `plugins: true` enables Chromium PDF in iframes — must not abort main agents.
  it('returns false for subframe/iframe navigation (e.g. PDF viewer)', () => {
    expect(
      shouldAbortAgentsOnNavigation(
        {
          isSameDocument: false,
          isMainFrame: false,
          frame: null,
        },
        PACKAGED,
      ),
    ).toBe(false);
  });

  // Unpackaged, the only source of a main-frame document navigation is a Vite full reload — which
  // any edit under src/renderer/ triggers, including one made by a parallel session that never
  // touched the app. Killing live agents for that is indistinguishable from a hang to the user.
  it('returns false for a main-frame reload when unpackaged (dev HMR)', () => {
    expect(
      shouldAbortAgentsOnNavigation({ isSameDocument: false, isMainFrame: true, frame: null }, DEV),
    ).toBe(false);
  });

  it('still returns false for same-document and subframe navigation when unpackaged', () => {
    expect(
      shouldAbortAgentsOnNavigation({ isSameDocument: true, isMainFrame: true, frame: null }, DEV),
    ).toBe(false);
    expect(
      shouldAbortAgentsOnNavigation(
        { isSameDocument: false, isMainFrame: false, frame: null },
        DEV,
      ),
    ).toBe(false);
  });
});

/**
 * The wiring decides between two very different outcomes for the same event: packaged reloads
 * ABORT window-scoped runs; dev reloads let them survive but must RELEASE stream-chunk ownership
 * (the window keeps its webContents.id while losing its transports — without the release the
 * surviving run streams delta-only payloads at a window that can no longer reduce them, a frozen
 * transcript). Same-document/subframe navigations must do neither.
 */
describe('attachAgentAbortOnRendererLifecycle navigation wiring', () => {
  const fakeWebContents = () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      wc: {
        id: 7,
        on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
      },
      navigate: (details: { isSameDocument: boolean; isMainFrame: boolean }) =>
        handlers.get('did-start-navigation')?.(details),
    };
  };

  beforeEach(() => {
    abortMock.mockClear();
    releaseMock.mockClear();
    releaseLiveMock.mockClear();
  });

  it('packaged main-frame document navigation aborts the window-scoped runs', () => {
    electronState.isPackaged = true;
    const { wc, navigate } = fakeWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    navigate({ isSameDocument: false, isMainFrame: true });

    expect(abortMock).toHaveBeenCalledWith(7, 'renderer-reload');
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('dev full reload releases ownership without aborting', () => {
    electronState.isPackaged = false;
    const { wc, navigate } = fakeWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    navigate({ isSameDocument: false, isMainFrame: true });

    expect(abortMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledWith(7);
    expect(releaseLiveMock).toHaveBeenCalledWith(7);
  });

  it('same-document and subframe navigations neither abort nor release', () => {
    electronState.isPackaged = false;
    const { wc, navigate } = fakeWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    navigate({ isSameDocument: true, isMainFrame: true });
    navigate({ isSameDocument: false, isMainFrame: false });

    expect(abortMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });
});

/**
 * A crashed renderer leaves a permanently disposed frame otherwise: broadcasters fire into it for
 * the rest of the app session and claimed-task dispatches drop silently. Reload recovers it in
 * place — at most once per cooldown so a repeatedly failing renderer cannot enter an unbounded
 * loop. There is no handshake: the reloaded renderer rehydrates itself via tRPC projection
 * queries, and a frame that never comes back simply leaves runs alive and checkpointing to SQLite.
 */
describe('crash auto-reload', () => {
  const crashableWebContents = () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const reload = vi.fn();
    const wc = {
      id: 9,
      reload,
      getURL: () => 'app://frink/index.html',
      isDestroyed: () => false,
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    };
    return {
      wc,
      reload,
      crash: (reason: string) => handlers.get('render-process-gone')?.({}, { reason }),
      destroy: () => handlers.get('destroyed')?.(),
      navigate: (details: { isSameDocument: boolean; isMainFrame: boolean; url?: string }) =>
        handlers.get('did-start-navigation')?.({ url: 'app://frink/index.html', ...details }),
    };
  };

  beforeEach(async () => {
    abortMock.mockClear();
    releaseMock.mockClear();
    releaseLiveMock.mockClear();
    captureMock.mockClear();
    const { _resetRendererReloadCooldownForTests } = await import('./navigation-abort');
    _resetRendererReloadCooldownForTests();
  });

  it('crashed outside cooldown releases ownership and reloads without aborting', () => {
    const { wc, reload, crash } = crashableWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    crash('crashed');

    expect(releaseMock).toHaveBeenCalledWith(9);
    expect(releaseLiveMock).toHaveBeenCalledWith(9);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('exempts the recovery reload itself from the packaged navigation abort, once', () => {
    electronState.isPackaged = true;
    const { wc, reload, crash, navigate } = crashableWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    crash('crashed');
    expect(reload).toHaveBeenCalledTimes(1);
    // reload() surfaces as a main-frame document navigation: the runs it preserves must survive it.
    navigate({ isSameDocument: false, isMainFrame: true });
    expect(abortMock).not.toHaveBeenCalled();
    // A later deliberate hard reload is a real teardown again.
    navigate({ isSameDocument: false, isMainFrame: true });
    expect(abortMock).toHaveBeenCalledWith(9, 'renderer-reload');
  });

  it('does not let an unrelated navigation spend the recovery-reload exemption', () => {
    electronState.isPackaged = true;
    const { wc, crash, navigate } = crashableWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    crash('crashed');
    // A different document racing the reload is a real teardown, not the recovery.
    navigate({ isSameDocument: false, isMainFrame: true, url: 'file:///other.html' });
    expect(abortMock).toHaveBeenCalledWith(9, 'renderer-reload');
    abortMock.mockClear();
    // The exemption was spent: the same-URL navigation that follows aborts too.
    navigate({ isSameDocument: false, isMainFrame: true });
    expect(abortMock).toHaveBeenCalledWith(9, 'renderer-reload');
  });

  it('voids the recovery-reload exemption when the renderer dies again first', () => {
    electronState.isPackaged = true;
    const { wc, crash, navigate } = crashableWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    crash('crashed');
    crash('crashed'); // within cooldown: abort + dead frame
    expect(abortMock).toHaveBeenCalledWith(9, 'renderer-crashed');
    abortMock.mockClear();
    navigate({ isSameDocument: false, isMainFrame: true });
    expect(abortMock).toHaveBeenCalledWith(9, 'renderer-reload');
  });

  it('treats OS memory-eviction as an involuntary death that reloads without aborting', () => {
    const { wc, reload, crash } = crashableWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    crash('memory-eviction');

    expect(reload).toHaveBeenCalledTimes(1);
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('a second crash within cooldown aborts and leaves a dead frame reported to Sentry', () => {
    const { wc, reload, crash } = crashableWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    crash('crashed');
    crash('oom');

    expect(reload).toHaveBeenCalledTimes(1);
    expect(abortMock).toHaveBeenCalledWith(9, 'renderer-crashed');
    expect(captureMock).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'renderer-dead-frame',
    });
  });

  it('never reloads for teardown reasons (clean-exit, killed) and does not report to Sentry', () => {
    const { wc, reload, crash } = crashableWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    crash('clean-exit');
    crash('killed');

    expect(reload).not.toHaveBeenCalled();
    expect(abortMock).toHaveBeenCalledTimes(2);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('aborts and captures if reload throws', () => {
    const { wc, reload, crash } = crashableWebContents();
    reload.mockImplementationOnce(() => {
      throw new Error('reload failed');
    });
    attachAgentAbortOnRendererLifecycle(wc as never);

    crash('crashed');

    expect(abortMock).toHaveBeenCalledWith(9, 'renderer-crashed');
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'reload failed' }),
      {
        surface: 'renderer-recovery-failed',
        stage: 'reload-threw',
      },
    );
  });

  it('destroyed releases both ownerships without aborting (ordinary window close)', () => {
    const { wc, destroy } = crashableWebContents();
    attachAgentAbortOnRendererLifecycle(wc as never);

    destroy();

    expect(abortMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledWith(9);
    expect(releaseLiveMock).toHaveBeenCalledWith(9);
  });
});
