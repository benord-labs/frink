import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import {
  type DiagnosticContext,
  sanitizeDiagnosticContext,
} from '../../../shared/sentry/diagnostic-context';
import { readMcpConfigSync } from '../mcp/config';
import {
  captureMainDiagnosticMessage,
  captureMainException,
  isSentryInitialized,
  setMainDiagnosticContext,
} from '../sentry/init';
import {
  findFreshMinidump,
  markCrashpadShutdown,
  startCrashpadCapture,
} from './crashpad-oom-evidence';
import {
  classifyProcessGoneReason,
  findRendererOomEvidence,
  ownsRendererDeath,
} from './process-gone-diagnostics';
import { recordConfiguredMcpTopology } from './provider-topology';
import {
  classifyPriorSession,
  findCorrelatedMainOomReport,
  type TerminationClassification,
  TerminationJournal,
} from './termination-journal';

const JOURNAL_FILENAME = 'runtime-termination.json';
const SHUTDOWN_STARTED_BUDGET_MS = 500;
const MAX_BOOT_SESSION_SOURCE_LENGTH = 200;

let journal: TerminationJournal | null = null;
let latestSnapshot: DiagnosticContext | null = null;
// Electron reports pid 0 for a dead renderer, so each webContents' pid is recorded while it is alive.
const rendererPidByWebContents = new Map<number, number>();
const loggedFailures = new Set<string>();

export function createBootSessionToken(
  platform: 'darwin' | 'linux',
  raw: string,
): string | undefined {
  const source = raw.trim();
  if (!source || source.length > MAX_BOOT_SESSION_SOURCE_LENGTH) return undefined;
  return crypto.createHash('sha256').update(`${platform}:${source}`).digest('hex').slice(0, 24);
}

function resolveBootSessionToken(): string | undefined {
  try {
    if (process.platform === 'linux') {
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return createBootSessionToken('linux', bootId);
    }
    if (process.platform === 'darwin') {
      const bootSessionUuid = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        maxBuffer: 1_024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1_000,
      });
      return createBootSessionToken('darwin', bootSessionUuid);
    }
  } catch {
    // A missing or unreadable platform token is unknown evidence, never proof of a reboot.
  }
  return undefined;
}

function logFailureOnce(operation: string, error: unknown): void {
  if (loggedFailures.has(operation)) return;
  loggedFailures.add(operation);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'unknown')
      : 'unknown';
  log.warn('[oom-diagnostics] persistence unavailable', {
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
    code,
  });
}

function previousSessionLevel(
  classification: TerminationClassification,
): 'fatal' | 'error' | 'warning' {
  if (classification === 'confirmed_main_oom') return 'fatal';
  if (classification === 'host_restart_after_unclean_session') return 'warning';
  return 'error';
}

function logIncident(
  level: 'fatal' | 'error' | 'warning',
  message: string,
  evidence: Record<string, unknown>,
): void {
  if (level === 'warning') log.warn(message, evidence);
  else log.error(message, evidence);
}

export function startOomObservability(): void {
  if (journal) return;

  // Sentry owns Crashpad in packaged builds; a packaged build without Sentry has no OOM evidence.
  startCrashpadCapture({ startHandler: !app.isPackaged && !isSentryInitialized() });
  const now = Date.now();
  const currentBootSessionToken = resolveBootSessionToken();
  recordConfiguredMcpTopology(readMcpConfigSync().servers);
  journal = new TerminationJournal(path.join(app.getPath('userData'), JOURNAL_FILENAME));
  void journal
    .beginSession({
      sessionId: crypto.randomUUID(),
      pid: process.pid,
      processStartedAtMs: Math.round(now - process.uptime() * 1_000),
      sessionStartedAtMs: now,
      ...(currentBootSessionToken ? { bootSessionToken: currentBootSessionToken } : {}),
    })
    .then(async (prior) => {
      if (!prior || prior.lifecycle === 'clean') return;
      const mainOom = await findCorrelatedMainOomReport(app.getPath('userData'), prior, now);
      const classification = classifyPriorSession(prior, {
        bootSessionToken: currentBootSessionToken,
        confirmedMainOom: !!mainOom,
      });
      if (!classification) return;

      const evidence = {
        classification,
        priorLifecycle: prior.lifecycle,
        confirmedOom: classification === 'confirmed_main_oom',
        hostRestart: classification === 'host_restart_after_unclean_session',
        nodeFatalReport: !!mainOom,
        snapshot: prior.latestSnapshot ?? null,
      };
      logIncident(
        previousSessionLevel(classification),
        '[oom-diagnostics] previous session ended without a clean marker',
        evidence,
      );
      captureMainDiagnosticMessage(
        `previous Frink session ended:${classification}`,
        previousSessionLevel(classification),
        {
          classification,
          priorLifecycle: prior.lifecycle,
          confirmedOom: String(evidence.confirmedOom),
          hostRestart: String(evidence.hostRestart),
          nodeFatalReport: String(evidence.nodeFatalReport),
        },
        prior.latestSnapshot,
      );
    })
    .catch((error) => logFailureOnce('begin-session', error));
}

export function recordRuntimeSnapshot(snapshot: DiagnosticContext): void {
  const safeSnapshot = sanitizeDiagnosticContext(snapshot);
  if (!safeSnapshot) return;
  latestSnapshot = safeSnapshot;
  setMainDiagnosticContext(safeSnapshot);
  void journal
    ?.updateSnapshot(safeSnapshot)
    .catch((error) => logFailureOnce('update-snapshot', error));
}

export async function markDiagnosticsShutdownStarted(): Promise<void> {
  markCrashpadShutdown();
  const operation =
    journal?.markLifecycle('shutdown_started').catch((error) => {
      logFailureOnce('shutdown-started', error);
    }) ?? Promise.resolve();
  const budget = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, SHUTDOWN_STARTED_BUDGET_MS);
    timeout.unref();
  });
  await Promise.race([operation, budget]);
}

export async function markDiagnosticsCleanShutdown(): Promise<void> {
  try {
    await journal?.markLifecycle('clean');
  } catch (error) {
    logFailureOnce('clean-shutdown', error);
  }
}

type ProcessGoneDeps = { findFreshMinidump: typeof findFreshMinidump };

export function recordElectronProcessGone(
  input: {
    source: 'renderer' | 'child';
    processType: string;
    reason: string;
    exitCode?: number;
    crashedAtMs?: number;
    /** The dead renderer's pid, recorded while it was alive; undefined when it never reached dom-ready. */
    rendererPid?: number;
  },
  deps: ProcessGoneDeps = { findFreshMinidump },
): void {
  const assessment = classifyProcessGoneReason(input.reason);
  // The auto-reload refills the module snapshot with post-crash numbers within seconds.
  const snapshot = latestSnapshot;
  const incident = {
    source: input.source,
    processType: input.processType,
    reason: input.reason,
    exitCode: input.exitCode ?? null,
    rendererPid: input.rendererPid ?? null,
    classification: assessment.classification,
    confirmedOom: assessment.confirmedOom,
    snapshot,
  };
  logIncident(assessment.level, '[oom-diagnostics] Electron process gone', incident);
  captureMainDiagnosticMessage(
    `Electron process terminated:${input.source}:${assessment.classification}`,
    assessment.level,
    {
      source: input.source,
      processType: input.processType,
      reason: input.reason,
      exitCode: String(input.exitCode ?? 'unknown'),
      classification: assessment.classification,
      confirmedOom: String(assessment.confirmedOom),
    },
    snapshot ?? undefined,
  );
  // A renderer whose pid was never recorded cannot be matched to a dump; its death stays unconfirmed.
  if (
    input.source === 'renderer' &&
    input.reason === 'crashed' &&
    input.rendererPid !== undefined
  ) {
    void confirmRendererOom(
      input.crashedAtMs ?? Date.now(),
      input.rendererPid,
      snapshot,
      deps,
    ).catch((error) => logFailureOnce('confirm-renderer-oom', error));
  }
}

/**
 * Electron reports a macOS renderer out-of-memory as a plain crash; the Crashpad dump written for
 * that death carries Chromium's OOM crash key. Follows the synchronous record above, never replaces it.
 */
async function confirmRendererOom(
  crashedAtMs: number,
  rendererPid: number,
  snapshot: DiagnosticContext | null,
  deps: ProcessGoneDeps,
): Promise<void> {
  const dump = await deps.findFreshMinidump(crashedAtMs, {
    accept: (annotations) => ownsRendererDeath(annotations, rendererPid),
    onMalformed: (path) => {
      log.warn('[oom-diagnostics] Crashpad dump for the renderer death is malformed', { path });
      captureMainException(new Error('malformed Crashpad minidump'), {
        surface: 'crashpad-oom-evidence',
      });
    },
  });
  if (!dump) return;
  const evidence = findRendererOomEvidence(dump.annotations);
  if (!evidence) {
    log.warn('[oom-diagnostics] Crashpad dump for the renderer death carries no OOM crash key', {
      path: dump.path,
      keys: Object.keys(dump.annotations),
    });
    return;
  }
  const tags = {
    classification: 'confirmed_oom',
    confirmedOom: 'true',
    evidence: 'crashpad_oom_key',
    allocator: evidence.allocator,
    crashKey: evidence.crashKey,
    crashKeyValue: evidence.crashKeyValue,
  };
  log.error('[oom-diagnostics] renderer OOM confirmed by Crashpad crash key', {
    ...tags,
    path: dump.path,
    snapshot,
  });
  captureMainDiagnosticMessage(
    'Electron process OOM confirmed:renderer:crashpad_oom_key',
    'fatal',
    tags,
    snapshot ?? undefined,
  );
}

export function registerElectronProcessGoneDiagnostics(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('dom-ready', () =>
      rendererPidByWebContents.set(contents.id, contents.getOSProcessId()),
    );
    contents.once('destroyed', () => rendererPidByWebContents.delete(contents.id));
  });
  app.on('render-process-gone', (_event, webContents, details) => {
    const rendererPid = rendererPidByWebContents.get(webContents.id);
    rendererPidByWebContents.delete(webContents.id);
    recordElectronProcessGone({
      source: 'renderer',
      processType: 'Tab',
      reason: details.reason,
      exitCode: details.exitCode,
      crashedAtMs: Date.now(),
      rendererPid,
    });
  });
  app.on('child-process-gone', (_event, details) => {
    recordElectronProcessGone({
      source: 'child',
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}
