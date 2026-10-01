import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = {
  info: vi.fn(),
  warn: vi.fn(),
};
const observabilitySpy = {
  start: vi.fn(),
  record: vi.fn(),
};

vi.mock('electron-log', () => ({
  default: logSpy,
}));

vi.mock('node:os', () => ({
  totalmem: () => 16 * 1024 * 1024 * 1024,
  freemem: () => 8 * 1024 * 1024 * 1024,
}));

vi.mock('./oom-observability', () => ({
  startOomObservability: observabilitySpy.start,
  recordRuntimeSnapshot: observabilitySpy.record,
}));

type FootprintReading = {
  perPid: Map<number, { physFootprintKb: number; peakKb: number }>;
  swappedKb: number | undefined;
};

const footprintMock = vi.fn(async (): Promise<FootprintReading | null> => null);

// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('./macos-footprint', () => ({
  readRendererFootprints: footprintMock,
}));

function footprintReading(entries: Array<[number, number]>, swappedKb?: number): FootprintReading {
  return {
    perPid: new Map(
      entries.map(([pid, footprintMb]) => [
        pid,
        { physFootprintKb: footprintMb * 1024, peakKb: footprintMb * 1024 },
      ]),
    ),
    swappedKb,
  };
}

/**
 * The probe is fire-and-forget, so a reading is consumed by the tick after the one that requested
 * it. Settle the pending probe, then advance one idle interval.
 */
async function advanceToNextSample(): Promise<void> {
  await vi.advanceTimersByTimeAsync(30_000);
}

const appMetricsMock = vi.fn(
  (): Array<{ type: string; pid: number; memory: { workingSetSize: number } }> => [],
);

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/frink-test-userData'),
    getAppMetrics: appMetricsMock,
  },
}));

const fakeHeapStats = {
  heap_size_limit: 4_000_000_000,
};

vi.mock('node:v8', () => ({
  getHeapStatistics: () => fakeHeapStats,
  writeHeapSnapshot: vi.fn(),
}));

// `process.memoryUsage` is a native function; `vi.spyOn` refuses to replace it
// cleanly across test files. Overwrite the property directly and restore after.
const originalMemoryUsage = process.memoryUsage;

describe('heap-watch', () => {
  beforeEach(() => {
    logSpy.info.mockClear();
    logSpy.warn.mockClear();
    observabilitySpy.start.mockClear();
    observabilitySpy.record.mockClear();
    appMetricsMock.mockReturnValue([]);
    footprintMock.mockReset();
    footprintMock.mockResolvedValue(null);
    // Fresh module each test so the internal `timer` module state is reset.
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { stopHeapWatch } = await import('./heap-watch');
    stopHeapWatch();
    vi.useRealTimers();
    Object.defineProperty(process, 'memoryUsage', {
      value: originalMemoryUsage,
      configurable: true,
    });
  });

  function stubHeapUsed(bytes: number): void {
    Object.defineProperty(process, 'memoryUsage', {
      value: () => ({
        rss: bytes + 100_000_000,
        heapTotal: bytes + 1_000_000,
        heapUsed: bytes,
        external: 0,
        arrayBuffers: 0,
      }),
      configurable: true,
    });
  }

  it('logs at info level when heap usage is below the warn threshold', async () => {
    stubHeapUsed(1_000_000_000); // 25% of limit
    const { startHeapWatch } = await import('./heap-watch');
    startHeapWatch();

    expect(logSpy.info).toHaveBeenCalled();
    expect(logSpy.warn).not.toHaveBeenCalled();
    const firstArg = logSpy.info.mock.calls[0]?.[0];
    expect(firstArg).toBe('[heap-watch] sample');
    expect(observabilitySpy.start).toHaveBeenCalledTimes(1);
    expect(observabilitySpy.record).toHaveBeenCalledTimes(1);
  });

  it('labels a sample at or above 85% of the heap size limit as pressure, at info level', async () => {
    stubHeapUsed(3_500_000_000); // 87.5% of limit
    const { startHeapWatch } = await import('./heap-watch');
    startHeapWatch();

    expect(logSpy.info.mock.calls[0]?.[0]).toBe('[heap-watch] pressure sample');
  });

  it('is idempotent — a second start does not create a second interval', async () => {
    stubHeapUsed(1_000_000_000);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    startHeapWatch();
    startHeapWatch();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('stopHeapWatch clears the interval so no further ticks fire', async () => {
    stubHeapUsed(1_000_000_000);
    const { startHeapWatch, stopHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    const initialTickCount = logSpy.info.mock.calls.length;

    stopHeapWatch();
    vi.advanceTimersByTime(60_000); // 2 tick intervals

    expect(logSpy.info.mock.calls.length).toBe(initialTickCount);
  });

  it('after stop, start works again (timer can be restarted)', async () => {
    stubHeapUsed(1_000_000_000);
    const { startHeapWatch, stopHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    stopHeapWatch();
    logSpy.info.mockClear();

    startHeapWatch();
    expect(logSpy.info).toHaveBeenCalledTimes(1);
  });

  it('parses Linux MemAvailable without treating raw MemFree as availability', async () => {
    const { parseLinuxMemAvailableKb } = await import('./heap-watch');

    expect(
      parseLinuxMemAvailableKb('MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\n'),
    ).toBe(8_192_000);
    expect(parseLinuxMemAvailableKb('MemTotal: 16384000 kB\nMemFree: 128000 kB\n')).toBeUndefined();
  });

  // Renderer processes OOM at their own V8 limit while main's heap stays flat. Sentry receives
  // aggregate evidence; process identity is kept in the local log only.
  it('records aggregate renderer working sets and escalates a huge one to warn', async () => {
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Browser', pid: 1, memory: { workingSetSize: 500 * 1024 } },
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
      { type: 'Tab', pid: 43, memory: { workingSetSize: 3000 * 1024 } },
    ]);
    const { startHeapWatch } = await import('./heap-watch');
    startHeapWatch();

    expect(logSpy.info).toHaveBeenCalledWith(
      '[heap-watch] pressure sample',
      expect.objectContaining({
        renderer_count: 2,
        renderer_working_set_sum_mb: 3300,
        renderer_max_working_set_mb: 3000,
        renderer_pressure: true,
      }),
    );
    expect(observabilitySpy.record).toHaveBeenCalledWith(
      expect.objectContaining({ renderer_max_working_set_mb: 3000 }),
    );
    expect(logSpy.info).toHaveBeenCalledWith(
      '[heap-watch] renderer memory',
      expect.stringContaining('pid=42'),
    );
  });

  // macOS working set omits compressed and swapped pages, so a leaking renderer looks smaller the
  // worse it gets. Physical footprint is what must drive the threshold.
  it('trips renderer pressure on a footprint far exceeding a small working set', async () => {
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
    ]);
    footprintMock.mockResolvedValue(footprintReading([[42, 13_600]], 12_100 * 1024));
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    // The first sample predates the probe: 300 MB working set is below every threshold.
    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer_pressure: false, renderer_footprint_measured: false }),
    );

    await advanceToNextSample();

    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        renderer_footprint_measured: true,
        renderer_max_footprint_mb: 13_600,
        renderer_footprint_sum_mb: 13_600,
        renderer_swapped_sum_mb: 12_100,
        renderer_max_working_set_mb: 300,
        renderer_pressure: true,
      }),
    );
    expect(logSpy.info).toHaveBeenCalledWith(
      '[heap-watch] renderer memory',
      expect.stringContaining('footprint=13600MB'),
    );
  });

  it('falls back to working set when the probe yields nothing', async () => {
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 3_000 * 1024 } },
    ]);
    footprintMock.mockResolvedValue(null);
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    await advanceToNextSample();

    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        renderer_footprint_measured: false,
        renderer_max_footprint_mb: 0,
        renderer_max_working_set_mb: 3_000,
        renderer_pressure: true,
      }),
    );
  });

  it('reports unmeasured when the probe covers only some renderers', async () => {
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
      { type: 'Tab', pid: 43, memory: { workingSetSize: 300 * 1024 } },
    ]);
    footprintMock.mockResolvedValue(footprintReading([[42, 9_000]]));
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    await advanceToNextSample();

    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer_footprint_measured: false, renderer_pressure: false }),
    );
  });

  it('never probes when there is no renderer to measure', async () => {
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Browser', pid: 1, memory: { workingSetSize: 500 * 1024 } },
    ]);
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    await advanceToNextSample();

    expect(footprintMock).not.toHaveBeenCalled();
  });

  it('stops reporting a footprint once the probe has gone quiet', async () => {
    // A reading nobody refreshed is not the current footprint. Reporting it as current would be
    // the same class of confident-but-wrong number this whole measurement replaced.
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
    ]);
    footprintMock.mockResolvedValue(footprintReading([[42, 13_600]]));
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    await advanceToNextSample();
    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer_footprint_measured: true }),
    );

    footprintMock.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(200_000);

    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer_footprint_measured: false, renderer_max_footprint_mb: 0 }),
    );
  });

  it('paces probes and judges freshness on the monotonic clock, not the wall clock', async () => {
    // A wall-clock step (NTP, manual) must neither revive a stale reading nor let a spawn through.
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
    ]);
    footprintMock.mockResolvedValue(footprintReading([[42, 13_600]]));
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    await advanceToNextSample();
    const probesBeforeStep = footprintMock.mock.calls.length;

    footprintMock.mockResolvedValue(null);
    vi.setSystemTime(Date.now() - 10 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5_000);

    // 35s after the last attempt: still inside the minute, and the reading is still fresh.
    expect(footprintMock.mock.calls.length).toBe(probesBeforeStep);
    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer_footprint_measured: true }),
    );

    // Elapsed time, not wall-clock time, retires the reading once probes stop landing.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer_footprint_measured: false }),
    );
  });

  it('probes at most once a minute even at the 5s pressure cadence', async () => {
    // Pressure accelerates sampling to 5s; the probe spawns a process and must not follow it.
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
    ]);
    footprintMock.mockResolvedValue(footprintReading([[42, 13_600]]));
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(observabilitySpy.record.mock.calls.length).toBeGreaterThan(12);
    expect(footprintMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('never runs two probes at once when one is slower than the interval', async () => {
    // A thrashing host is exactly when the probe is slowest and when piling up spawns is worst.
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
    ]);
    footprintMock.mockReturnValue(new Promise<FootprintReading | null>(() => {}));
    const { startHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(footprintMock).toHaveBeenCalledTimes(1);
  });

  it('does not adopt a probe that resolves after the watch was stopped', async () => {
    // stopHeapWatch runs in the quit path's synchronous teardown; a probe already in flight must
    // not repopulate the cache behind it, or a restart reports the previous run's numbers.
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
    ]);
    let settleProbe: (reading: FootprintReading | null) => void = () => {};
    footprintMock.mockReturnValue(
      new Promise<FootprintReading | null>((resolve) => {
        settleProbe = resolve;
      }),
    );
    const { startHeapWatch, stopHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    stopHeapWatch();
    settleProbe(footprintReading([[42, 13_600]]));
    await vi.advanceTimersByTimeAsync(0);
    observabilitySpy.record.mockClear();

    footprintMock.mockResolvedValue(null);
    startHeapWatch();

    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer_footprint_measured: false, renderer_max_footprint_mb: 0 }),
    );
  });

  it('discards the cached footprint when the watch is stopped', async () => {
    stubHeapUsed(1_000_000_000);
    appMetricsMock.mockReturnValue([
      { type: 'Tab', pid: 42, memory: { workingSetSize: 300 * 1024 } },
    ]);
    footprintMock.mockResolvedValue(footprintReading([[42, 13_600]]));
    const { startHeapWatch, stopHeapWatch } = await import('./heap-watch');

    startHeapWatch();
    await advanceToNextSample();
    stopHeapWatch();
    observabilitySpy.record.mockClear();

    // A restart must measure afresh rather than reporting the previous run's numbers.
    footprintMock.mockResolvedValue(null);
    startHeapWatch();

    expect(observabilitySpy.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer_footprint_measured: false, renderer_max_footprint_mb: 0 }),
    );
  });
});
