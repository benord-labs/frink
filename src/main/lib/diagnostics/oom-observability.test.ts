import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
  setContext: vi.fn(),
  appOn: vi.fn(),
  findFreshMinidump: vi.fn(
    async (
      _crashedAtMs: number,
      _options: {
        accept: (a: Record<string, string>) => boolean;
        onMalformed?: (p: string) => void;
      },
    ): Promise<{ path: string; annotations: Record<string, string> } | null> => null,
  ),
  log: { fatal: vi.fn(), error: vi.fn(), warning: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/frink-observability-test'),
    on: mocks.appOn,
  },
  safeStorage: {},
}));
vi.mock('electron-log', () => ({ default: mocks.log }));
vi.mock('../sentry/init', () => ({
  captureMainDiagnosticMessage: mocks.capture,
  captureMainException: mocks.captureException,
  isSentryInitialized: vi.fn(() => false),
  setMainDiagnosticContext: mocks.setContext,
}));

import {
  createBootSessionToken,
  recordElectronProcessGone,
  recordRuntimeSnapshot,
  registerElectronProcessGoneDiagnostics,
} from './oom-observability';

describe('createBootSessionToken', () => {
  it('creates a bounded local token without retaining the raw OS identifier', () => {
    const raw = 'D84565D3-53E0-4971-9CEB-68F59064EBD3';
    const token = createBootSessionToken('darwin', ` ${raw}\n`);

    expect(token).toMatch(/^[a-f0-9]{24}$/);
    expect(token).toBe(createBootSessionToken('darwin', raw));
    expect(token).not.toContain(raw);
    expect(createBootSessionToken('linux', raw)).not.toBe(token);
    expect(createBootSessionToken('darwin', '  ')).toBeUndefined();
    expect(createBootSessionToken('darwin', 'x'.repeat(201))).toBeUndefined();
  });
});

describe('recordElectronProcessGone', () => {
  const finder = { findFreshMinidump: mocks.findFreshMinidump };
  beforeEach(() => vi.clearAllMocks());

  it('records confirmed Electron OOM without collapsing distinct matching exits', () => {
    const event = {
      source: 'child' as const,
      processType: 'Utility',
      reason: 'oom',
      exitCode: 9,
    };

    recordElectronProcessGone(event);
    recordElectronProcessGone(event);

    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenLastCalledWith(
      'Electron process terminated:child:confirmed_oom',
      'fatal',
      expect.objectContaining({
        classification: 'confirmed_oom',
        confirmedOom: 'true',
        reason: 'oom',
      }),
      undefined,
    );
  });

  it('keeps memory eviction distinct from confirmed OOM', () => {
    recordElectronProcessGone({
      source: 'renderer',
      processType: 'Tab',
      reason: 'memory-eviction',
    });

    expect(mocks.capture).toHaveBeenCalledWith(
      'Electron process terminated:renderer:memory_eviction',
      'error',
      expect.objectContaining({
        classification: 'memory_eviction',
        confirmedOom: 'false',
      }),
      undefined,
    );
  });

  it('follows a renderer crash with an OOM confirmation once the dump names the crash key', async () => {
    recordRuntimeSnapshot({ schema_version: 1, main_rss_mb: 256 });
    mocks.findFreshMinidump.mockResolvedValueOnce({
      path: '/dumps/a.dmp',
      annotations: { 'page-allocator-mapped-size': '43487285248', process_type: 'renderer' },
    });

    recordElectronProcessGone(
      {
        source: 'renderer',
        processType: 'Tab',
        reason: 'crashed',
        exitCode: 5,
        crashedAtMs: 1_000,
        rendererPid: 7,
      },
      finder,
    );
    // The reloaded renderer reports fresh numbers before the dump settles; evidence keeps the crash-time ones.
    recordRuntimeSnapshot({ schema_version: 1, main_rss_mb: 999 });

    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(2));
    expect(mocks.findFreshMinidump).toHaveBeenCalledWith(
      1_000,
      expect.objectContaining({ accept: expect.any(Function) }),
    );
    expect(mocks.capture).toHaveBeenNthCalledWith(
      1,
      'Electron process terminated:renderer:unexpected_crash',
      'fatal',
      expect.objectContaining({ confirmedOom: 'false' }),
      { schema_version: 1, main_rss_mb: 256 },
    );
    expect(mocks.capture).toHaveBeenNthCalledWith(
      2,
      'Electron process OOM confirmed:renderer:crashpad_oom_key',
      'fatal',
      {
        classification: 'confirmed_oom',
        confirmedOom: 'true',
        evidence: 'crashpad_oom_key',
        allocator: 'partition-alloc',
        crashKey: 'page-allocator-mapped-size',
        crashKeyValue: '43487285248',
      },
      { schema_version: 1, main_rss_mb: 256 },
    );
  });

  it('leaves a renderer crash unconfirmed when the dump has no OOM key or never appears', async () => {
    mocks.findFreshMinidump.mockResolvedValueOnce({
      path: '/dumps/b.dmp',
      annotations: { process_type: 'renderer' },
    });

    const death = {
      source: 'renderer' as const,
      processType: 'Tab',
      reason: 'crashed',
      rendererPid: 7,
    };
    recordElectronProcessGone(death, finder);
    recordElectronProcessGone(death, finder);

    await vi.waitFor(() =>
      expect(mocks.log.warn).toHaveBeenCalledWith(
        '[oom-diagnostics] Crashpad dump for the renderer death carries no OOM crash key',
        { path: '/dumps/b.dmp', keys: ['process_type'] },
      ),
    );
    expect(mocks.findFreshMinidump).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it('reports a malformed dump to Sentry instead of confirming anything', async () => {
    mocks.findFreshMinidump.mockImplementationOnce(async (_crashedAtMs, options) => {
      options.onMalformed?.('/dumps/c.dmp');
      return null;
    });

    recordElectronProcessGone(
      { source: 'renderer', processType: 'Tab', reason: 'crashed', rendererPid: 7 },
      finder,
    );

    await vi.waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
        surface: 'crashpad-oom-evidence',
      }),
    );
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it('lets only a dump of the dead renderer through the accept gate', async () => {
    mocks.findFreshMinidump.mockImplementationOnce(async (_crashedAtMs, options) => {
      expect(
        options.accept({ process_type: 'gpu-process', 'page-allocator-mapped-size': '1' }),
      ).toBe(false);
      expect(options.accept({ process_type: 'renderer', pid: '2' })).toBe(false);
      expect(options.accept({ process_type: 'renderer', pid: '7' })).toBe(true);
      expect(options.accept({ process_type: 'renderer' })).toBe(false);
      return null;
    });

    recordElectronProcessGone(
      { source: 'renderer', processType: 'Tab', reason: 'crashed', rendererPid: 7 },
      finder,
    );

    await vi.waitFor(() => expect(mocks.findFreshMinidump).toHaveBeenCalledTimes(1));
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it('never waits on a dump for deaths Electron already names or renderers it never sampled', () => {
    recordElectronProcessGone({ source: 'renderer', processType: 'Tab', reason: 'oom' }, finder);
    recordElectronProcessGone({ source: 'child', processType: 'GPU', reason: 'crashed' }, finder);
    recordElectronProcessGone(
      { source: 'renderer', processType: 'Tab', reason: 'crashed' },
      finder,
    );

    expect(mocks.findFreshMinidump).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledTimes(3);
  });

  it('registers both authoritative Electron process-gone boundaries', () => {
    registerElectronProcessGoneDiagnostics();
    expect(mocks.appOn).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    expect(mocks.appOn).toHaveBeenCalledWith('child-process-gone', expect.any(Function));
  });

  it('records each renderer pid at dom-ready and hands it to that webContents death only', () => {
    registerElectronProcessGoneDiagnostics();
    const created = mocks.appOn.mock.calls.find(([event]) => event === 'web-contents-created')?.[1];
    const gone = mocks.appOn.mock.calls.find(([event]) => event === 'render-process-gone')?.[1];
    const listeners: Record<string, () => void> = {};
    const fakeContents = (id: number, pid: number) => ({
      id,
      on: (event: string, listener: () => void) => {
        listeners[`${id}:${event}`] = listener;
      },
      once: () => {},
      getOSProcessId: () => pid,
    });
    created?.({}, fakeContents(3, 21));
    created?.({}, fakeContents(4, 22));
    listeners['3:dom-ready']?.();
    listeners['4:dom-ready']?.();

    gone?.({}, { id: 4 }, { reason: 'crashed', exitCode: 5 });
    expect(mocks.log.error).toHaveBeenLastCalledWith(
      '[oom-diagnostics] Electron process gone',
      expect.objectContaining({ rendererPid: 22 }),
    );

    // A webContents that never reached dom-ready, or one already taken, has no pid to offer.
    gone?.({}, { id: 4 }, { reason: 'crashed', exitCode: 5 });
    gone?.({}, { id: 9 }, { reason: 'crashed', exitCode: 5 });
    expect(mocks.log.error).toHaveBeenLastCalledWith(
      '[oom-diagnostics] Electron process gone',
      expect.objectContaining({ rendererPid: null }),
    );
  });

  it('sanitizes the snapshot before retaining it for local process-exit evidence', () => {
    recordRuntimeSnapshot({
      schema_version: 1,
      main_rss_mb: 512,
      projectPath: '/Users/private/project' as never,
    });
    recordElectronProcessGone({ source: 'renderer', processType: 'Tab', reason: 'crashed' });

    expect(mocks.setContext).toHaveBeenCalledWith({ schema_version: 1, main_rss_mb: 512 });
    expect(mocks.capture).toHaveBeenCalledWith(
      'Electron process terminated:renderer:unexpected_crash',
      'fatal',
      expect.any(Object),
      { schema_version: 1, main_rss_mb: 512 },
    );
  });
});
