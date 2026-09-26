import type { DiagnosticContext } from '../../../shared/sentry/diagnostic-context';

const BYTES_PER_MB = 1024 * 1024;
const KB_PER_MB = 1024;
const MAIN_WARN_PERCENT = 85;
const RENDERER_WARN_MB = 2_048;
/** Footprint runs ~2x working set on a healthy renderer, so it needs its own, higher bar. */
const RENDERER_FOOTPRINT_WARN_MB = 4_096;
const SYSTEM_AVAILABLE_WARN_PERCENT = 5;
const SUSTAINED_SYSTEM_PRESSURE_SAMPLES = 2;

type RuntimeTopologySnapshot = {
  activeExecutionCount: number;
  ownerlessExecutionCount: number;
  checkpointPersistCount: number;
  checkpointPersistMsTotal: number;
  checkpointPersistMsMax: number;
  checkpointPersistPartsMax: number;
  streamChunkGapMsMax: number;
  claudeSessionCount: number;
  claudeBusySessionCount: number;
  claudeRetainedSessionCount: number;
  claudeQueryStartsTotal: number;
  claudeQueryStarts60s: number;
  codexAppServerCount: number;
  codexLiveTurnCount: number;
  codexTurnStartsTotal: number;
  codexTurnStarts60s: number;
  configuredMcpTotal: number;
  configuredMcpStdio: number;
  configuredMcpHttp: number;
};

export type RuntimeSnapshotInput = {
  sampledAtMs: number;
  memoryUsage: NodeJS.MemoryUsage;
  heapSizeLimitBytes: number;
  systemMemory: {
    total: number;
    free: number;
    available?: number;
    fileBacked?: number;
    purgeable?: number;
  };
  appMetrics: Array<{
    type: string;
    workingSetSizeKb: number;
    /** macOS physical footprint, joined by pid before it reaches here so no identity is stored. */
    footprintKb?: number;
    footprintPeakKb?: number;
  }>;
  /** De-duplicated across the probed processes; footprint(1) reports no per-process swap. */
  rendererSwappedKb?: number;
  topology: RuntimeTopologySnapshot;
};

type ProcessBucket = {
  count: number;
  workingSetKb: number;
  maxWorkingSetKb: number;
  footprintCount: number;
  footprintKb: number;
  maxFootprintKb: number;
  maxFootprintPeakKb: number;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function bytesToMb(bytes: number): number {
  return round(bytes / BYTES_PER_MB);
}

function kbToMb(kb: number): number {
  return round(kb / KB_PER_MB);
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function createBucket(): ProcessBucket {
  return {
    count: 0,
    workingSetKb: 0,
    maxWorkingSetKb: 0,
    footprintCount: 0,
    footprintKb: 0,
    maxFootprintKb: 0,
    maxFootprintPeakKb: 0,
  };
}

function bucketName(type: string): 'browser' | 'renderer' | 'gpu' | 'utility' | 'other' {
  if (type === 'Browser') return 'browser';
  if (type === 'Tab') return 'renderer';
  if (type === 'GPU') return 'gpu';
  if (type === 'Utility') return 'utility';
  return 'other';
}

function aggregateProcesses(metrics: RuntimeSnapshotInput['appMetrics']) {
  const buckets = {
    browser: createBucket(),
    renderer: createBucket(),
    gpu: createBucket(),
    utility: createBucket(),
    other: createBucket(),
  };
  let totalWorkingSetKb = 0;

  for (const metric of metrics) {
    const workingSetKb = finiteNonNegative(metric.workingSetSizeKb);
    const bucket = buckets[bucketName(metric.type)];
    bucket.count += 1;
    bucket.workingSetKb += workingSetKb;
    bucket.maxWorkingSetKb = Math.max(bucket.maxWorkingSetKb, workingSetKb);
    totalWorkingSetKb += workingSetKb;

    if (metric.footprintKb === undefined) continue;
    const footprintKb = finiteNonNegative(metric.footprintKb);
    bucket.footprintCount += 1;
    bucket.footprintKb += footprintKb;
    bucket.maxFootprintKb = Math.max(bucket.maxFootprintKb, footprintKb);
    bucket.maxFootprintPeakKb = Math.max(
      bucket.maxFootprintPeakKb,
      finiteNonNegative(metric.footprintPeakKb),
    );
  }

  return { buckets, totalWorkingSetKb };
}

type RendererFootprintSummary = {
  measured: boolean;
  sumMb: number;
  maxMb: number;
  peakMb: number;
  swappedMb: number | undefined;
};

/**
 * Partial coverage reads as unmeasured: a renderer that exited mid-probe is absent from the output,
 * so figures from the renderers that were reached would understate the whole set.
 */
function summariseRendererFootprint(
  renderer: ProcessBucket,
  swappedKb: number | undefined,
): RendererFootprintSummary {
  const measured = renderer.count > 0 && renderer.footprintCount === renderer.count;
  if (!measured) return { measured, sumMb: 0, maxMb: 0, peakMb: 0, swappedMb: undefined };
  return {
    measured,
    sumMb: kbToMb(renderer.footprintKb),
    maxMb: kbToMb(renderer.maxFootprintKb),
    peakMb: kbToMb(renderer.maxFootprintPeakKb),
    swappedMb: swappedKb === undefined ? undefined : kbToMb(finiteNonNegative(swappedKb)),
  };
}

function isRendererPressure(
  footprint: RendererFootprintSummary,
  rendererMaxWorkingSetMb: number,
): boolean {
  return footprint.measured
    ? footprint.maxMb >= RENDERER_FOOTPRINT_WARN_MB
    : rendererMaxWorkingSetMb >= RENDERER_WARN_MB;
}

export class RuntimeSnapshotCollector {
  private sequence = 0;
  private peakMainHeapUsedMb = 0;
  private peakMainRssMb = 0;
  private peakRendererWorkingSetMb = 0;
  private peakRendererFootprintMb = 0;
  private peakElectronWorkingSetSumMb = 0;
  private systemPressureSamples = 0;

  collect(input: RuntimeSnapshotInput): DiagnosticContext {
    const { buckets, totalWorkingSetKb } = aggregateProcesses(input.appMetrics);
    const heapLimitBytes = Math.max(1, finiteNonNegative(input.heapSizeLimitBytes));
    const systemTotalKb = Math.max(1, finiteNonNegative(input.systemMemory.total));
    const mainHeapUsedBytes = finiteNonNegative(input.memoryUsage.heapUsed);
    const systemFreeKb = Math.min(systemTotalKb, finiteNonNegative(input.systemMemory.free));
    const systemFileBackedKb = finiteNonNegative(input.systemMemory.fileBacked);
    const systemPurgeableKb = finiteNonNegative(input.systemMemory.purgeable);
    const hasSystemAvailableSignal =
      input.systemMemory.available !== undefined ||
      input.systemMemory.fileBacked !== undefined ||
      input.systemMemory.purgeable !== undefined;
    const reportedAvailableKb =
      input.systemMemory.available === undefined
        ? systemFreeKb + systemFileBackedKb + systemPurgeableKb
        : finiteNonNegative(input.systemMemory.available);
    const systemAvailableKb = Math.min(systemTotalKb, reportedAvailableKb);
    const mainHeapUsedMb = bytesToMb(mainHeapUsedBytes);
    const mainRssMb = bytesToMb(finiteNonNegative(input.memoryUsage.rss));
    const rendererMaxWorkingSetMb = kbToMb(buckets.renderer.maxWorkingSetKb);
    const footprint = summariseRendererFootprint(buckets.renderer, input.rendererSwappedKb);
    const electronWorkingSetSumMb = kbToMb(totalWorkingSetKb);
    const mainHeapUsedPct = round((mainHeapUsedBytes / heapLimitBytes) * 100);
    const systemFreePct = round((systemFreeKb / systemTotalKb) * 100);
    const systemAvailablePct = round((systemAvailableKb / systemTotalKb) * 100);
    const systemPressure =
      hasSystemAvailableSignal && systemAvailablePct <= SYSTEM_AVAILABLE_WARN_PERCENT;

    this.sequence += 1;
    this.systemPressureSamples = systemPressure ? this.systemPressureSamples + 1 : 0;
    this.peakMainHeapUsedMb = Math.max(this.peakMainHeapUsedMb, mainHeapUsedMb);
    this.peakMainRssMb = Math.max(this.peakMainRssMb, mainRssMb);
    this.peakRendererWorkingSetMb = Math.max(
      this.peakRendererWorkingSetMb,
      rendererMaxWorkingSetMb,
    );
    // Held like the other peaks: the renderer that set the high-water mark is usually gone by the
    // time anyone reads the evidence, and an unmeasured sample must not erase it either.
    this.peakRendererFootprintMb = Math.max(this.peakRendererFootprintMb, footprint.peakMb);
    this.peakElectronWorkingSetSumMb = Math.max(
      this.peakElectronWorkingSetSumMb,
      electronWorkingSetSumMb,
    );

    const snapshot: DiagnosticContext = {
      schema_version: 1,
      sampled_at_ms: input.sampledAtMs,
      sample_sequence: this.sequence,
      main_heap_used_mb: mainHeapUsedMb,
      main_heap_total_mb: bytesToMb(input.memoryUsage.heapTotal),
      main_heap_limit_mb: bytesToMb(heapLimitBytes),
      main_heap_used_pct: mainHeapUsedPct,
      main_rss_mb: mainRssMb,
      main_external_mb: bytesToMb(input.memoryUsage.external),
      main_array_buffers_mb: bytesToMb(input.memoryUsage.arrayBuffers),
      system_total_mb: kbToMb(systemTotalKb),
      system_free_mb: kbToMb(systemFreeKb),
      system_free_pct: systemFreePct,
      system_available_mb: kbToMb(systemAvailableKb),
      system_available_pct: systemAvailablePct,
      system_file_backed_mb: kbToMb(systemFileBackedKb),
      system_purgeable_mb: kbToMb(systemPurgeableKb),
      system_pressure_measured: hasSystemAvailableSignal,
      electron_process_count: input.appMetrics.length,
      electron_working_set_sum_mb: electronWorkingSetSumMb,
      browser_count: buckets.browser.count,
      browser_working_set_sum_mb: kbToMb(buckets.browser.workingSetKb),
      renderer_count: buckets.renderer.count,
      renderer_working_set_sum_mb: kbToMb(buckets.renderer.workingSetKb),
      renderer_max_working_set_mb: rendererMaxWorkingSetMb,
      // Summed per process, so shared pages mapped by several renderers are counted once each.
      renderer_footprint_sum_mb: footprint.sumMb,
      renderer_max_footprint_mb: footprint.maxMb,
      // Sourced from the OS, so it covers the whole process lifetime rather than only the samples
      // taken, and held here so it survives that process exiting.
      peak_renderer_footprint_mb: this.peakRendererFootprintMb,
      renderer_footprint_measured: footprint.measured,
      gpu_count: buckets.gpu.count,
      gpu_working_set_sum_mb: kbToMb(buckets.gpu.workingSetKb),
      utility_count: buckets.utility.count,
      utility_working_set_sum_mb: kbToMb(buckets.utility.workingSetKb),
      other_process_count: buckets.other.count,
      other_working_set_sum_mb: kbToMb(buckets.other.workingSetKb),
      peak_main_heap_used_mb: this.peakMainHeapUsedMb,
      peak_main_rss_mb: this.peakMainRssMb,
      peak_renderer_working_set_mb: this.peakRendererWorkingSetMb,
      peak_electron_working_set_sum_mb: this.peakElectronWorkingSetSumMb,
      active_execution_count: input.topology.activeExecutionCount,
      ownerless_execution_count: input.topology.ownerlessExecutionCount,
      checkpoint_persist_count: input.topology.checkpointPersistCount,
      checkpoint_persist_ms_total: input.topology.checkpointPersistMsTotal,
      checkpoint_persist_ms_max: input.topology.checkpointPersistMsMax,
      checkpoint_persist_parts_max: input.topology.checkpointPersistPartsMax,
      stream_chunk_gap_ms_max: input.topology.streamChunkGapMsMax,
      claude_session_count: input.topology.claudeSessionCount,
      claude_busy_session_count: input.topology.claudeBusySessionCount,
      claude_retained_session_count: input.topology.claudeRetainedSessionCount,
      claude_query_starts_total: input.topology.claudeQueryStartsTotal,
      claude_query_starts_60s: input.topology.claudeQueryStarts60s,
      codex_app_server_count: input.topology.codexAppServerCount,
      codex_live_turn_count: input.topology.codexLiveTurnCount,
      codex_turn_starts_total: input.topology.codexTurnStartsTotal,
      codex_turn_starts_60s: input.topology.codexTurnStarts60s,
      configured_mcp_total: input.topology.configuredMcpTotal,
      configured_mcp_stdio: input.topology.configuredMcpStdio,
      configured_mcp_http: input.topology.configuredMcpHttp,
      main_pressure: mainHeapUsedPct >= MAIN_WARN_PERCENT,
      renderer_pressure: isRendererPressure(footprint, rendererMaxWorkingSetMb),
      system_pressure: systemPressure,
      system_pressure_sustained: this.systemPressureSamples >= SUSTAINED_SYSTEM_PRESSURE_SAMPLES,
      // Correlation-only: app.getAppMetrics does not cover arbitrary provider/MCP descendants.
      provider_descendant_memory_measured: false,
    };
    // footprint(1) may omit swap; an absent key means unknown, whereas 0 would claim none.
    if (footprint.swappedMb !== undefined) snapshot.renderer_swapped_sum_mb = footprint.swappedMb;
    return snapshot;
  }
}

export function shouldSampleRapidly(snapshot: DiagnosticContext): boolean {
  const mainHeapUsedPercent = snapshot.main_heap_used_pct;
  return (
    (typeof mainHeapUsedPercent === 'number' && mainHeapUsedPercent >= 50) ||
    snapshot.renderer_pressure === true ||
    snapshot.system_pressure_sustained === true
  );
}
