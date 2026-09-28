import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import log from 'electron-log';
import { ensureDirExistsAsync } from '../../fs-helpers';
import { frinkUserHome } from '../../platform/frink-home';

export const FLOW_ADMISSION_CONFIG_VERSION = 1;
export const MIN_CONCURRENT_FLOW_RUNS = 1;
export const MAX_CONCURRENT_FLOW_RUNS = 20;
export const DEFAULT_MAX_CONCURRENT_FLOW_RUNS = 4;

export type FlowAdmissionConfig = {
  version: typeof FLOW_ADMISSION_CONFIG_VERSION;
  queuePaused: boolean;
  concurrencyLimitEnabled: boolean;
  maxConcurrentRuns: number;
};

export type FlowAdmissionConfigPatch = Partial<
  Pick<FlowAdmissionConfig, 'queuePaused' | 'concurrencyLimitEnabled' | 'maxConcurrentRuns'>
>;

export const FRINK_FLOWS_DIR = path.join(frinkUserHome(), '.frink', 'flows');
export const FLOW_ADMISSION_CONFIG_PATH = path.join(FRINK_FLOWS_DIR, 'config.json');

const configMutex = new Mutex();

const freshDefaultConfig = (): FlowAdmissionConfig => ({
  version: FLOW_ADMISSION_CONFIG_VERSION,
  queuePaused: false,
  concurrencyLimitEnabled: true,
  maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_FLOW_RUNS,
});

function isValidConfig(
  value: unknown,
): value is Omit<FlowAdmissionConfig, 'queuePaused'> & { queuePaused?: boolean } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === FLOW_ADMISSION_CONFIG_VERSION &&
    (candidate.queuePaused === undefined || typeof candidate.queuePaused === 'boolean') &&
    typeof candidate.concurrencyLimitEnabled === 'boolean' &&
    Number.isInteger(candidate.maxConcurrentRuns) &&
    Number(candidate.maxConcurrentRuns) >= MIN_CONCURRENT_FLOW_RUNS &&
    Number(candidate.maxConcurrentRuns) <= MAX_CONCURRENT_FLOW_RUNS
  );
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/** Invalid, missing, or future-version config always degrades to the complete enabled/4 default. */
export async function readFlowAdmissionConfig(): Promise<FlowAdmissionConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(FLOW_ADMISSION_CONFIG_PATH, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) {
      log.warn('[flow-admission] Could not read flows config; using enabled/4 defaults');
    }
    return freshDefaultConfig();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValidConfig(parsed)) return { ...parsed, queuePaused: parsed.queuePaused ?? false };
    log.warn('[flow-admission] Invalid flows config; using enabled/4 defaults');
  } catch {
    log.warn('[flow-admission] Invalid flows config; using enabled/4 defaults');
  }
  return freshDefaultConfig();
}

function validatePatch(patch: FlowAdmissionConfigPatch): void {
  if (patch.queuePaused !== undefined && typeof patch.queuePaused !== 'boolean') {
    throw new TypeError('queuePaused must be a boolean');
  }
  if (
    patch.concurrencyLimitEnabled !== undefined &&
    typeof patch.concurrencyLimitEnabled !== 'boolean'
  ) {
    throw new TypeError('concurrencyLimitEnabled must be a boolean');
  }
  if (
    patch.maxConcurrentRuns !== undefined &&
    (!Number.isInteger(patch.maxConcurrentRuns) ||
      patch.maxConcurrentRuns < MIN_CONCURRENT_FLOW_RUNS ||
      patch.maxConcurrentRuns > MAX_CONCURRENT_FLOW_RUNS)
  ) {
    throw new RangeError(
      `maxConcurrentRuns must be an integer from ${MIN_CONCURRENT_FLOW_RUNS} to ${MAX_CONCURRENT_FLOW_RUNS}`,
    );
  }
}

async function replaceConfigFile(config: FlowAdmissionConfig): Promise<void> {
  await ensureDirExistsAsync(FRINK_FLOWS_DIR);
  const temporaryPath = path.join(FRINK_FLOWS_DIR, `.config.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, FLOW_ADMISSION_CONFIG_PATH);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Serialized read-modify-replace; disabling leaves the last numeric preference intact. */
export async function updateFlowAdmissionConfig(
  patch: FlowAdmissionConfigPatch,
): Promise<FlowAdmissionConfig> {
  validatePatch(patch);
  return configMutex.runExclusive(async () => {
    const current = await readFlowAdmissionConfig();
    const updated: FlowAdmissionConfig = {
      version: FLOW_ADMISSION_CONFIG_VERSION,
      queuePaused: patch.queuePaused ?? current.queuePaused,
      concurrencyLimitEnabled: patch.concurrencyLimitEnabled ?? current.concurrencyLimitEnabled,
      maxConcurrentRuns: patch.maxConcurrentRuns ?? current.maxConcurrentRuns,
    };
    await replaceConfigFile(updated);
    return updated;
  });
}

/** The isolated QA profile runs on this port; it is what isolates its userData. */
const QA_PROFILE_AUTH_SERVER_PORT = '21399';

/**
 * TEMPORARY, tracked by sc-2479. QA seeds queued admissions so Work Queue's "Queued to run" panel
 * has rows to drive; every drain — the startup sweep, and the one a removal triggers as it frees a
 * slot — would promote and DISPATCH them, emptying the panel mid-run. The honest fixture would fill
 * the concurrency cap instead, but that cap lives in the developer's real ~/.frink, which the QA
 * profile shares. sc-2479 isolates that config and deletes this whole function.
 *
 * The flag alone is deliberately NOT enough. An inherited environment variable would otherwise
 * strand a real user's queued work for the life of their session, so the freeze also requires the
 * process to BE the QA profile — the auth-server port that gives QA its own userData and sqlite.
 * A shipped app never runs on it.
 */
export function admissionDrainFrozen(): boolean {
  return (
    process.env.FRINK_DISABLE_FLOW_ADMISSION_DRAIN === '1' &&
    process.env.MAIN_VITE_AUTH_SERVER_PORT === QA_PROFILE_AUTH_SERVER_PORT
  );
}
