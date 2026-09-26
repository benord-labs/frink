import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type DiagnosticContext,
  sanitizeDiagnosticContext,
} from '../../../shared/sentry/diagnostic-context';

const SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_REPORT_PREFIX_BYTES = 64 * 1024;
const MAX_REPORT_CANDIDATES = 20;
const REPORT_CLOCK_TOLERANCE_MS = 5_000;
const MAIN_OOM_EVENT_PATTERN = /(?:heap out of memory|allocation failed)/i;
const NODE_REPORT_FILENAME_PATTERN = /^report\..+\.json$/;
const BOOT_SESSION_TOKEN_PATTERN = /^[a-f0-9]{24}$/;

export type TerminationLifecycle = 'running' | 'shutdown_started' | 'clean';

export type TerminationSessionIdentity = {
  sessionId: string;
  pid: number;
  processStartedAtMs: number;
  sessionStartedAtMs: number;
  /** Hashed, local-only OS boot identity. Never attached to remote diagnostics. */
  bootSessionToken?: string;
};

export type TerminationState = TerminationSessionIdentity & {
  schemaVersion: 1;
  lifecycle: TerminationLifecycle;
  revision: number;
  updatedAtMs: number;
  latestSnapshot?: DiagnosticContext;
};

export type TerminationClassification =
  | 'confirmed_main_oom'
  | 'unclean_app_termination'
  | 'host_restart_after_unclean_session'
  | 'incomplete_shutdown';

export type MainOomReportEvidence = {
  kind: 'main_v8_oom';
  occurredAtMs: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isLifecycle(value: unknown): value is TerminationLifecycle {
  return value === 'running' || value === 'shutdown_started' || value === 'clean';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isBoundedSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 100;
}

function isBootSessionToken(value: unknown): value is string {
  return typeof value === 'string' && BOOT_SESSION_TOKEN_PATTERN.test(value);
}

const REQUIRED_STATE_FIELDS: ReadonlyArray<readonly [string, (value: unknown) => boolean]> = [
  ['schemaVersion', (value) => value === SCHEMA_VERSION],
  ['sessionId', isBoundedSessionId],
  ['pid', isPositiveInteger],
  ['processStartedAtMs', isFiniteNumber],
  ['sessionStartedAtMs', isFiniteNumber],
  ['lifecycle', isLifecycle],
  ['revision', isPositiveInteger],
  ['updatedAtMs', isFiniteNumber],
];

function normalizeState(value: unknown): TerminationState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fieldsAreValid = REQUIRED_STATE_FIELDS.every(([key, validate]) => validate(record[key]));
  if (!fieldsAreValid) return null;

  const validated = record as Omit<TerminationState, 'latestSnapshot' | 'bootSessionToken'> & {
    bootSessionToken?: unknown;
    latestSnapshot?: unknown;
  };
  const bootSessionToken = isBootSessionToken(validated.bootSessionToken)
    ? validated.bootSessionToken
    : undefined;
  const latestSnapshot = sanitizeDiagnosticContext(validated.latestSnapshot);
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: validated.sessionId,
    pid: validated.pid,
    processStartedAtMs: validated.processStartedAtMs,
    sessionStartedAtMs: validated.sessionStartedAtMs,
    ...(bootSessionToken ? { bootSessionToken } : {}),
    lifecycle: validated.lifecycle,
    revision: validated.revision,
    updatedAtMs: validated.updatedAtMs,
    ...(latestSnapshot && Object.keys(latestSnapshot).length > 0 ? { latestSnapshot } : {}),
  };
}

export async function readTerminationState(filePath: string): Promise<TerminationState | null> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= 0 || stat.size > MAX_JOURNAL_BYTES) return null;
    return normalizeState(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // A torn atomic replacement or manually corrupted app-owned marker must not permanently
    // disable future diagnostics. Invalid content is untrusted evidence, so discard it.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeStateAtomically(filePath: string, state: TerminationState): Promise<void> {
  const directory = path.dirname(filePath);
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(tmpPath, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/** One serialized writer prevents a late sample from racing the terminal clean state. */
export class TerminationJournal {
  private writeChain = Promise.resolve();
  private current: TerminationState | null = null;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly readState: typeof readTerminationState = readTerminationState,
  ) {}

  beginSession(identity: TerminationSessionIdentity): Promise<TerminationState | null> {
    return this.enqueue(async () => {
      let prior: TerminationState | null = null;
      let readError: unknown;
      try {
        prior = await this.readState(this.filePath);
      } catch (error) {
        readError = error;
      }
      this.current = {
        schemaVersion: SCHEMA_VERSION,
        ...identity,
        lifecycle: 'running',
        revision: 1,
        updatedAtMs: this.now(),
      };
      await writeStateAtomically(this.filePath, this.current);
      // Preserve local error visibility without leaving the current session permanently inert.
      // The caller logs this failure; later snapshots/lifecycle writes remain able to proceed.
      if (readError) throw readError;
      return prior;
    });
  }

  updateSnapshot(snapshot: DiagnosticContext): Promise<void> {
    return this.enqueue(async () => {
      if (!this.current) return;
      const safeSnapshot = sanitizeDiagnosticContext(snapshot);
      this.current = {
        ...this.current,
        revision: this.current.revision + 1,
        updatedAtMs: this.now(),
        ...(safeSnapshot ? { latestSnapshot: safeSnapshot } : {}),
      };
      await writeStateAtomically(this.filePath, this.current);
    });
  }

  markLifecycle(lifecycle: Exclude<TerminationLifecycle, 'running'>): Promise<void> {
    return this.enqueue(async () => {
      if (!this.current) return;
      if (this.current.lifecycle === 'clean') return;
      if (this.current.lifecycle === 'shutdown_started' && lifecycle === 'shutdown_started') return;
      this.current = {
        ...this.current,
        lifecycle,
        revision: this.current.revision + 1,
        updatedAtMs: this.now(),
      };
      await writeStateAtomically(this.filePath, this.current);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseJsonString(prefix: string, key: string): string | null {
  const match = prefix.match(new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function parseInteger(prefix: string, key: string): number | null {
  const match = prefix.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseCorrelatedMainOomReportPrefix(
  prefix: string,
  prior: TerminationSessionIdentity,
  endedBeforeMs: number,
): MainOomReportEvidence | null {
  const event = parseJsonString(prefix, 'event');
  const pid = parseInteger(prefix, 'processId');
  const timestampText = parseJsonString(prefix, 'dumpEventTimeStamp');
  const occurredAtMs = timestampText ? Number(timestampText) : null;
  if (
    pid !== prior.pid ||
    !occurredAtMs ||
    !Number.isFinite(occurredAtMs) ||
    occurredAtMs < prior.processStartedAtMs - REPORT_CLOCK_TOLERANCE_MS ||
    occurredAtMs > endedBeforeMs + REPORT_CLOCK_TOLERANCE_MS
  ) {
    return null;
  }
  if (!event || !MAIN_OOM_EVENT_PATTERN.test(event)) return null;
  return { kind: 'main_v8_oom', occurredAtMs };
}

async function readPrefix(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_REPORT_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function findCorrelatedMainOomReport(
  directory: string,
  prior: TerminationSessionIdentity,
  endedBeforeMs: number,
): Promise<MainOomReportEvidence | null> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && NODE_REPORT_FILENAME_PATTERN.test(entry.name))
      // Node report filenames begin with a sortable date/time. Bound reads to the newest reports
      // without depending on filesystem directory order.
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, MAX_REPORT_CANDIDATES);

    for (const entry of candidates) {
      const reportPath = path.join(directory, entry.name);
      const stat = await fs.stat(reportPath);
      if (
        stat.mtimeMs < prior.processStartedAtMs - REPORT_CLOCK_TOLERANCE_MS ||
        stat.mtimeMs > endedBeforeMs + REPORT_CLOCK_TOLERANCE_MS
      ) {
        continue;
      }
      const evidence = parseCorrelatedMainOomReportPrefix(
        await readPrefix(reportPath),
        prior,
        endedBeforeMs,
      );
      if (evidence) return evidence;
    }
  } catch {
    // Diagnostics must fail open for startup and fail closed for OOM classification.
  }
  return null;
}

export function classifyPriorSession(
  prior: TerminationState,
  current: { bootSessionToken?: string; confirmedMainOom: boolean },
): TerminationClassification | null {
  if (prior.lifecycle === 'clean') return null;
  if (current.confirmedMainOom) return 'confirmed_main_oom';
  if (prior.lifecycle === 'shutdown_started') return 'incomplete_shutdown';
  if (
    prior.bootSessionToken &&
    current.bootSessionToken &&
    prior.bootSessionToken !== current.bootSessionToken
  ) {
    return 'host_restart_after_unclean_session';
  }
  return 'unclean_app_termination';
}
