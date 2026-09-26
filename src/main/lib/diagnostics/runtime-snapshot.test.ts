import { describe, expect, it } from 'vitest';

import { sanitizeDiagnosticContext } from '../../../shared/sentry/diagnostic-context';
import { RuntimeSnapshotCollector, shouldSampleRapidly } from './runtime-snapshot';

/**
 * Every field zeroed, overridable per test. A literal per call site meant each new topology field
 * broke every unrelated test in this file, which is churn that teaches nothing.
 */
const topology = (
  overrides: Partial<Parameters<RuntimeSnapshotCollector['collect']>[0]['topology']> = {},
): Parameters<RuntimeSnapshotCollector['collect']>[0]['topology'] => ({
  activeExecutionCount: 0,
  ownerlessExecutionCount: 0,
  claudeSessionCount: 0,
  claudeBusySessionCount: 0,
  claudeRetainedSessionCount: 0,
  claudeQueryStartsTotal: 0,
  claudeQueryStarts60s: 0,
  codexAppServerCount: 0,
  codexLiveTurnCount: 0,
  codexTurnStartsTotal: 0,
  codexTurnStarts60s: 0,
  configuredMcpTotal: 0,
  configuredMcpStdio: 0,
  configuredMcpHttp: 0,
  checkpointPersistCount: 0,
  checkpointPersistMsTotal: 0,
  checkpointPersistMsMax: 0,
  checkpointPersistPartsMax: 0,
  streamChunkGapMsMax: 0,
  ...overrides,
});

describe('RuntimeSnapshotCollector', () => {
  it('aggregates bounded scalar memory and topology evidence without process identity', () => {
    const collector = new RuntimeSnapshotCollector();
    const snapshot = collector.collect({
      sampledAtMs: 1_000,
      memoryUsage: {
        rss: 600 * 1024 * 1024,
        heapTotal: 400 * 1024 * 1024,
        heapUsed: 300 * 1024 * 1024,
        external: 20 * 1024 * 1024,
        arrayBuffers: 10 * 1024 * 1024,
      },
      heapSizeLimitBytes: 1_000 * 1024 * 1024,
      systemMemory: {
        total: 16 * 1024 * 1024,
        free: 512 * 1024,
        fileBacked: 2 * 1024 * 1024,
        purgeable: 256 * 1024,
      },
      appMetrics: [
        { type: 'Browser', workingSetSizeKb: 600 * 1024 },
        { type: 'Tab', workingSetSizeKb: 900 * 1024 },
        { type: 'Tab', workingSetSizeKb: 1_200 * 1024 },
        { type: 'GPU', workingSetSizeKb: 200 * 1024 },
        { type: 'Utility', workingSetSizeKb: 100 * 1024 },
      ],
      topology: topology({
        activeExecutionCount: 6,
        ownerlessExecutionCount: 2,
        claudeSessionCount: 4,
        claudeBusySessionCount: 3,
        claudeRetainedSessionCount: 1,
        claudeQueryStartsTotal: 8,
        claudeQueryStarts60s: 5,
        codexAppServerCount: 3,
        codexLiveTurnCount: 2,
        codexTurnStartsTotal: 7,
        codexTurnStarts60s: 4,
        configuredMcpTotal: 34,
        configuredMcpStdio: 26,
        configuredMcpHttp: 8,
        checkpointPersistCount: 12,
        checkpointPersistMsTotal: 240,
        checkpointPersistMsMax: 55,
        checkpointPersistPartsMax: 90,
        streamChunkGapMsMax: 9_800,
      }),
    });

    expect(snapshot).toMatchObject({
      schema_version: 1,
      sample_sequence: 1,
      main_heap_used_mb: 300,
      main_heap_used_pct: 30,
      system_free_pct: 3.13,
      system_available_pct: 17.19,
      electron_process_count: 5,
      electron_working_set_sum_mb: 3_000,
      renderer_count: 2,
      renderer_working_set_sum_mb: 2_100,
      renderer_max_working_set_mb: 1_200,
      active_execution_count: 6,
      ownerless_execution_count: 2,
      checkpoint_persist_count: 12,
      checkpoint_persist_ms_total: 240,
      checkpoint_persist_ms_max: 55,
      checkpoint_persist_parts_max: 90,
      stream_chunk_gap_ms_max: 9_800,
      claude_session_count: 4,
      claude_retained_session_count: 1,
      codex_app_server_count: 3,
      codex_live_turn_count: 2,
      codex_turn_starts_total: 7,
      codex_turn_starts_60s: 4,
      configured_mcp_total: 34,
      system_pressure_measured: true,
      system_pressure: false,
      system_pressure_sustained: false,
      provider_descendant_memory_measured: false,
    });
    expect(
      Object.values(snapshot).every((value) =>
        ['string', 'number', 'boolean'].includes(typeof value),
      ),
    ).toBe(true);
    expect(snapshot).not.toHaveProperty('pid');
    expect(snapshot).not.toHaveProperty('name');
    expect(snapshot).not.toHaveProperty('command');
  });

  it('retains peaks across samples and marks renderer pressure independently of main V8', () => {
    const collector = new RuntimeSnapshotCollector();
    const base = {
      memoryUsage: {
        rss: 200 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 50 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      },
      heapSizeLimitBytes: 1_000 * 1024 * 1024,
      systemMemory: { total: 16 * 1024 * 1024, free: 8 * 1024 * 1024 },
      topology: topology(),
    };

    collector.collect({
      ...base,
      sampledAtMs: 1,
      appMetrics: [{ type: 'Tab', workingSetSizeKb: 3_000 * 1024 }],
    });
    const later = collector.collect({
      ...base,
      sampledAtMs: 2,
      appMetrics: [{ type: 'Tab', workingSetSizeKb: 300 * 1024 }],
    });

    expect(later.renderer_pressure).toBe(false);
    expect(later.peak_renderer_working_set_mb).toBe(3_000);
    expect(later.sample_sequence).toBe(2);
  });

  it('accelerates only after genuinely low available memory is sustained', () => {
    const collector = new RuntimeSnapshotCollector();
    const input = {
      memoryUsage: {
        rss: 200 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 50 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      },
      heapSizeLimitBytes: 1_000 * 1024 * 1024,
      systemMemory: {
        total: 16 * 1024 * 1024,
        free: 128 * 1024,
        available: 512 * 1024,
      },
      appMetrics: [],
      topology: topology(),
    };

    const first = collector.collect({ ...input, sampledAtMs: 1 });
    const second = collector.collect({ ...input, sampledAtMs: 2 });
    const recovered = collector.collect({
      ...input,
      sampledAtMs: 3,
      systemMemory: {
        ...input.systemMemory,
        free: 8 * 1024 * 1024,
        available: 8 * 1024 * 1024,
      },
    });

    expect(first).toMatchObject({ system_pressure: true, system_pressure_sustained: false });
    expect(shouldSampleRapidly(first)).toBe(false);
    expect(second).toMatchObject({ system_pressure: true, system_pressure_sustained: true });
    expect(shouldSampleRapidly(second)).toBe(true);
    expect(recovered).toMatchObject({ system_pressure: false, system_pressure_sustained: false });
  });

  it('does not infer system pressure from raw free memory when availability is unmeasured', () => {
    const collector = new RuntimeSnapshotCollector();
    const snapshot = collector.collect({
      sampledAtMs: 1,
      memoryUsage: {
        rss: 200 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 50 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      },
      heapSizeLimitBytes: 1_000 * 1024 * 1024,
      systemMemory: { total: 16 * 1024 * 1024, free: 128 * 1024 },
      appMetrics: [],
      topology: topology(),
    });

    expect(snapshot).toMatchObject({
      system_pressure_measured: false,
      system_pressure: false,
      system_pressure_sustained: false,
    });
    expect(shouldSampleRapidly(snapshot)).toBe(false);
  });
});

describe('the sample survives the Sentry scrubber intact', () => {
  it('keeps every key collect() emits', () => {
    // sanitizeDiagnosticContext drops any key missing from its allowlist, SILENTLY. A field added
    // to the snapshot but not to NUMBER_KEYS/BOOLEAN_KEYS therefore reaches the local log and
    // vanishes from every crash report, with nothing failing to say so. Asserting the whole key
    // set — rather than the fields of the day — makes that impossible to introduce later.
    // SAFETY: a literal fixture standing in for the process's own memory report.
    const snapshot = new RuntimeSnapshotCollector().collect({
      sampledAtMs: 1_000,
      memoryUsage: {
        rss: 1,
        heapTotal: 1,
        heapUsed: 1,
        external: 1,
        arrayBuffers: 1,
      } as NodeJS.MemoryUsage,
      heapSizeLimitBytes: 1_000,
      systemMemory: { total: 100, free: 10, available: 20 },
      appMetrics: [{ type: 'Browser', workingSetSizeKb: 1 }],
      topology: topology({ streamChunkGapMsMax: 7 }),
    });

    const sanitized = sanitizeDiagnosticContext(snapshot);

    expect(sanitized).not.toBeNull();
    expect(Object.keys(sanitized ?? {}).sort()).toEqual(Object.keys(snapshot).sort());
  });
});

describe('RuntimeSnapshotCollector footprint precedence', () => {
  const base = {
    sampledAtMs: 1,
    memoryUsage: {
      rss: 200 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      heapUsed: 50 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    },
    heapSizeLimitBytes: 1_000 * 1024 * 1024,
    systemMemory: { total: 16 * 1024 * 1024, free: 8 * 1024 * 1024 },
    topology: topology(),
  };

  it('measures pressure against physical footprint, not the working set it dwarfs', () => {
    const snapshot = new RuntimeSnapshotCollector().collect({
      ...base,
      appMetrics: [
        {
          type: 'Tab',
          workingSetSizeKb: 300 * 1024,
          footprintKb: 13_600 * 1024,
          footprintPeakKb: 13_800 * 1024,
        },
      ],
      rendererSwappedKb: 12_100 * 1024,
    });

    expect(snapshot.renderer_footprint_measured).toBe(true);
    expect(snapshot.renderer_max_footprint_mb).toBe(13_600);
    expect(snapshot.peak_renderer_footprint_mb).toBe(13_800);
    expect(snapshot.renderer_swapped_sum_mb).toBe(12_100);
    expect(snapshot.renderer_max_working_set_mb).toBe(300);
    expect(snapshot.renderer_pressure).toBe(true);
  });

  it('holds pressure below the footprint bar where the working-set bar would have tripped', () => {
    // 3 GB resident trips the 2 GB working-set bar, but 3 GB of real footprint is not yet pressure.
    const snapshot = new RuntimeSnapshotCollector().collect({
      ...base,
      appMetrics: [{ type: 'Tab', workingSetSizeKb: 3_000 * 1024, footprintKb: 3_000 * 1024 }],
    });

    expect(snapshot.renderer_pressure).toBe(false);
  });

  it('falls back to the working-set bar when no renderer was measured', () => {
    const snapshot = new RuntimeSnapshotCollector().collect({
      ...base,
      appMetrics: [{ type: 'Tab', workingSetSizeKb: 3_000 * 1024 }],
    });

    expect(snapshot.renderer_footprint_measured).toBe(false);
    expect(snapshot.renderer_max_footprint_mb).toBe(0);
    expect(snapshot.renderer_pressure).toBe(true);
  });

  it('treats partial renderer coverage as unmeasured', () => {
    const snapshot = new RuntimeSnapshotCollector().collect({
      ...base,
      appMetrics: [
        {
          type: 'Tab',
          workingSetSizeKb: 300 * 1024,
          footprintKb: 9_000 * 1024,
          footprintPeakKb: 12_000 * 1024,
        },
        { type: 'Tab', workingSetSizeKb: 300 * 1024 },
      ],
      rendererSwappedKb: 8_000 * 1024,
    });

    expect(snapshot.renderer_footprint_measured).toBe(false);
    expect(snapshot.renderer_pressure).toBe(false);
    // Survivor-only figures would understate the renderers the probe missed, so none are reported.
    expect(snapshot).toMatchObject({
      renderer_footprint_sum_mb: 0,
      renderer_max_footprint_mb: 0,
      peak_renderer_footprint_mb: 0,
    });
    expect(snapshot).not.toHaveProperty('renderer_swapped_sum_mb');
  });

  it('omits swap rather than reporting zero when the probe measured none', () => {
    // A measured sample carrying swap 0 would claim no swap; an absent key says it is unknown.
    const snapshot = new RuntimeSnapshotCollector().collect({
      ...base,
      appMetrics: [{ type: 'Tab', workingSetSizeKb: 300 * 1024, footprintKb: 900 * 1024 }],
    });

    expect(snapshot.renderer_footprint_measured).toBe(true);
    expect(snapshot).not.toHaveProperty('renderer_swapped_sum_mb');
  });

  it('keeps every footprint field through the Sentry allowlist', () => {
    const snapshot = new RuntimeSnapshotCollector().collect({
      ...base,
      appMetrics: [
        {
          type: 'Tab',
          workingSetSizeKb: 300 * 1024,
          footprintKb: 13_600 * 1024,
          footprintPeakKb: 13_800 * 1024,
        },
      ],
      rendererSwappedKb: 12_100 * 1024,
    });

    expect(sanitizeDiagnosticContext(snapshot)).toMatchObject({
      renderer_footprint_sum_mb: 13_600,
      renderer_max_footprint_mb: 13_600,
      peak_renderer_footprint_mb: 13_800,
      renderer_swapped_sum_mb: 12_100,
      renderer_footprint_measured: true,
    });
  });
});

describe('RuntimeSnapshotCollector footprint peak', () => {
  const base = {
    memoryUsage: {
      rss: 200 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      heapUsed: 50 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    },
    heapSizeLimitBytes: 1_000 * 1024 * 1024,
    systemMemory: { total: 16 * 1024 * 1024, free: 8 * 1024 * 1024 },
    topology: topology(),
  };

  it('holds the renderer footprint peak after the renderer carrying it exits', () => {
    // The peak is the evidence a post-mortem reader needs most; it must not vanish with the
    // process that set it, exactly as peak_renderer_working_set_mb survives.
    const collector = new RuntimeSnapshotCollector();
    collector.collect({
      ...base,
      sampledAtMs: 1,
      appMetrics: [
        {
          type: 'Tab',
          workingSetSizeKb: 300 * 1024,
          footprintKb: 900 * 1024,
          footprintPeakKb: 13_800 * 1024,
        },
      ],
    });

    const afterExit = collector.collect({
      ...base,
      sampledAtMs: 2,
      appMetrics: [
        {
          type: 'Tab',
          workingSetSizeKb: 300 * 1024,
          footprintKb: 400 * 1024,
          footprintPeakKb: 500 * 1024,
        },
      ],
    });

    expect(afterExit.peak_renderer_footprint_mb).toBe(13_800);
  });

  it('holds the renderer footprint peak when a later probe measures nothing', () => {
    const collector = new RuntimeSnapshotCollector();
    collector.collect({
      ...base,
      sampledAtMs: 1,
      appMetrics: [
        {
          type: 'Tab',
          workingSetSizeKb: 300 * 1024,
          footprintKb: 900 * 1024,
          footprintPeakKb: 13_800 * 1024,
        },
      ],
    });

    const unmeasured = collector.collect({
      ...base,
      sampledAtMs: 2,
      appMetrics: [{ type: 'Tab', workingSetSizeKb: 300 * 1024 }],
    });

    expect(unmeasured.renderer_footprint_measured).toBe(false);
    expect(unmeasured.peak_renderer_footprint_mb).toBe(13_800);
  });
});
