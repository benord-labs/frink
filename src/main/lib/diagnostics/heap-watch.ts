import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import { app } from 'electron';
import log from 'electron-log';
import type { DiagnosticContext } from '../../../shared/sentry/diagnostic-context';
import { type FootprintSample, readRendererFootprints } from './macos-footprint';
import { recordRuntimeSnapshot, startOomObservability } from './oom-observability';
import { getRuntimeTopologySnapshot } from './provider-topology';
import { RuntimeSnapshotCollector, shouldSampleRapidly } from './runtime-snapshot';

const TICK_MS_IDLE = 30_000;
const TICK_MS_PRESSURE = 5_000;
const LINUX_MEM_AVAILABLE_REGEX = /^MemAvailable:\s+(\d+)\s+kB$/m;
/**
 * Snapshot threshold. Lower than the warn-only level (0.85) because
 * `v8.writeHeapSnapshot()` itself allocates roughly the live heap as scratch
 * space; firing too late risks tipping the OOM it is meant to capture.
 */
const SNAPSHOT_RATIO = 0.7;
/** Throttle snapshots so we never spend the heap diagnosing it. */
const MIN_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
/** The probe spawns a child process, so it runs well below the sampling cadence. */
const MIN_FOOTPRINT_INTERVAL_MS = 60 * 1000;
/** Once probes stop landing, the last reading is dropped rather than reported as current. */
const MAX_FOOTPRINT_AGE_MS = 3 * MIN_FOOTPRINT_INTERVAL_MS;

let timer: ReturnType<typeof setInterval> | null = null;
let currentTickMs = TICK_MS_IDLE;
let lastSnapshotAt = 0;
let lastFootprint: FootprintSample | null = null;
/** Monotonic ms: a wall-clock step can neither revive a stale reading nor admit an extra probe. */
let lastFootprintAt = 0;
let lastFootprintProbeAt = Number.NEGATIVE_INFINITY;
let footprintProbeInFlight = false;
/** Bumped on stop so a probe still in flight cannot write into the run that follows it. */
let footprintGeneration = 0;
const snapshotCollector = new RuntimeSnapshotCollector();

function tryWriteSnapshot(): void {
  const now = Date.now();
  if (now - lastSnapshotAt < MIN_SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotAt = now;
  try {
    const filename = `heap-${new Date(now).toISOString().replace(/[:.]/g, '-')}.heapsnapshot`;
    const target = path.join(app.getPath('userData'), filename);
    // Pre-existing, local-only artifact. It is never attached to the new Sentry context or parsed
    // by termination recovery; scalar diagnostics in this PR do not broaden its privacy boundary.
    v8.writeHeapSnapshot(target);
    log.warn(`[heap-watch] heap snapshot written: ${target}`);
  } catch (error) {
    log.warn('[heap-watch] writeHeapSnapshot failed', error);
  }
}

function getSystemMemoryInfo(): {
  total: number;
  free: number;
  available?: number;
  fileBacked?: number;
  purgeable?: number;
} {
  const electronProcess = process as NodeJS.Process & {
    getSystemMemoryInfo?: () => {
      total: number;
      free: number;
      available?: number;
      fileBacked?: number;
      purgeable?: number;
    };
  };
  if (typeof electronProcess.getSystemMemoryInfo === 'function') {
    const info = electronProcess.getSystemMemoryInfo();
    if (process.platform === 'linux') {
      return { ...info, available: getLinuxAvailableMemoryKb() };
    }
    // Electron exposes no cache-aware availability value on Windows. Keep raw free memory as
    // descriptive evidence, but fail closed instead of inferring pressure from it.
    return info;
  }
  // Unit-test / non-Electron fallback. Electron reports KiB, while Node reports bytes.
  const free = Math.max(1, os.freemem() / 1024);
  return { total: Math.max(1, os.totalmem() / 1024), free };
}

export function parseLinuxMemAvailableKb(contents: string): number | undefined {
  const match = LINUX_MEM_AVAILABLE_REGEX.exec(contents);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function getLinuxAvailableMemoryKb(): number | undefined {
  try {
    return parseLinuxMemAvailableKb(readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    return undefined;
  }
}

function logRendererMemory(
  metrics: ReturnType<typeof app.getAppMetrics>,
  footprint: FootprintSample | null,
): void {
  const summary = metrics
    .filter((metric) => metric.type === 'Tab')
    .map((metric) => {
      const workingSetMb = Math.round(metric.memory.workingSetSize / 1024);
      const footprintKb = footprint?.perPid.get(metric.pid)?.physFootprintKb;
      const footprintMb =
        footprintKb === undefined ? '' : ` footprint=${Math.round(footprintKb / 1024)}MB`;
      return `pid=${metric.pid} workingSet=${workingSetMb}MB${footprintMb}`;
    })
    .join(' ');
  if (summary) log.info('[heap-watch] renderer memory', summary);
}

/** A reading the probe has stopped refreshing must not be presented as the current footprint. */
function freshFootprint(monotonicNowMs: number): FootprintSample | null {
  if (!lastFootprint) return null;
  return monotonicNowMs - lastFootprintAt <= MAX_FOOTPRINT_AGE_MS ? lastFootprint : null;
}

/**
 * Refreshes the footprint cache without blocking a sample, so no probe outlives stopHeapWatch().
 * Rate-limited on attempts, not successes, so a failing probe cannot spawn on every tick.
 */
function scheduleFootprintProbe(rendererPids: number[], monotonicNowMs: number): void {
  if (footprintProbeInFlight || rendererPids.length === 0) return;
  if (monotonicNowMs - lastFootprintProbeAt < MIN_FOOTPRINT_INTERVAL_MS) return;

  const generation = footprintGeneration;
  lastFootprintProbeAt = monotonicNowMs;
  footprintProbeInFlight = true;
  void readRendererFootprints(rendererPids)
    .then((reading) => {
      if (!reading || generation !== footprintGeneration) return;
      lastFootprint = reading;
      lastFootprintAt = performance.now();
    })
    .finally(() => {
      if (generation === footprintGeneration) footprintProbeInFlight = false;
    });
}

function collectRuntimeSample(): {
  memoryUsage: NodeJS.MemoryUsage;
  heapSizeLimitBytes: number;
  snapshot: DiagnosticContext;
} {
  const memoryUsage = process.memoryUsage();
  const heapSizeLimitBytes = v8.getHeapStatistics().heap_size_limit;
  const appMetrics = app.getAppMetrics();
  const sampledAtMs = Date.now();
  const monotonicNowMs = performance.now();
  const footprint = freshFootprint(monotonicNowMs);
  // Process identifiers stay in the local log only; the uploaded snapshot remains aggregate-only.
  logRendererMemory(appMetrics, footprint);
  scheduleFootprintProbe(
    appMetrics.filter((metric) => metric.type === 'Tab').map((metric) => metric.pid),
    monotonicNowMs,
  );
  const snapshot = snapshotCollector.collect({
    sampledAtMs,
    memoryUsage,
    heapSizeLimitBytes,
    systemMemory: getSystemMemoryInfo(),
    appMetrics: appMetrics.map((metric) => ({
      type: metric.type,
      workingSetSizeKb: metric.memory.workingSetSize,
      footprintKb: footprint?.perPid.get(metric.pid)?.physFootprintKb,
      footprintPeakKb: footprint?.perPid.get(metric.pid)?.peakKb,
    })),
    rendererSwappedKb: footprint?.swappedKb,
    topology: getRuntimeTopologySnapshot(),
  });
  return { memoryUsage, heapSizeLimitBytes, snapshot };
}

function logRuntimeSample(snapshot: DiagnosticContext): void {
  const isPressure = [
    snapshot.main_pressure,
    snapshot.renderer_pressure,
    snapshot.system_pressure,
  ].includes(true);
  // Info even under pressure: warn reaches the terminal, and this object would be a large blocking
  // write there every 5 s exactly when the machine is loaded.
  log.info(isPressure ? '[heap-watch] pressure sample' : '[heap-watch] sample', snapshot);
  recordRuntimeSnapshot(snapshot);
}

function updateSamplingCadence(snapshot: DiagnosticContext): void {
  const desiredTickMs = shouldSampleRapidly(snapshot) ? TICK_MS_PRESSURE : TICK_MS_IDLE;
  if (desiredTickMs === currentTickMs) return;

  currentTickMs = desiredTickMs;
  if (!timer) return;
  clearInterval(timer);
  timer = setInterval(tick, currentTickMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function tick(): void {
  try {
    const { memoryUsage, heapSizeLimitBytes, snapshot } = collectRuntimeSample();
    logRuntimeSample(snapshot);
    if (memoryUsage.heapUsed / heapSizeLimitBytes >= SNAPSHOT_RATIO) tryWriteSnapshot();
    // Adapt sampling cadence so a main, renderer, or system pressure window is not invisible.
    updateSamplingCadence(snapshot);
  } catch (error) {
    log.warn('[heap-watch] diagnostic sample failed', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

export function startHeapWatch(): void {
  if (timer) return;

  // Node's diagnostic report on C++-level fatal errors (OOM, CHECK failures).
  // Written to userData so it survives an app crash. Deliberately not enabling
  // reportOnUncaughtException — that would write a multi-MB synchronous dump
  // on every JS throw, which stalls startup if anything rejects early.
  try {
    process.report.directory = app.getPath('userData');
    // Node reports contain env by default; keep the local fatal artifact useful without copying
    // secrets. Recovery reads only a bounded header prefix and uploads no raw report content.
    process.report.excludeEnv = true;
    process.report.reportOnFatalError = true;
  } catch (error) {
    log.warn('[heap-watch] could not enable process.report', error);
  }

  startOomObservability();
  currentTickMs = TICK_MS_IDLE;
  tick();
  timer = setInterval(tick, currentTickMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopHeapWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Drop the cache so a restart reports fresh measurements rather than the previous run's, and
  // disown any probe still running: it cannot be cancelled, only ignored when it lands.
  lastFootprint = null;
  lastFootprintProbeAt = Number.NEGATIVE_INFINITY;
  footprintProbeInFlight = false;
  footprintGeneration += 1;
}
