import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { app, crashReporter, type CrashReporterStartOptions } from 'electron';
import log from 'electron-log';
import { type CrashpadAnnotations, readCrashpadAnnotations } from './minidump-annotations';

const DUMP_WAIT_TIMEOUT_MS = 8_000;
const DUMP_POLL_INTERVAL_MS = 250;
// Crashpad writes the dump after the death; a dump older than this belongs to an earlier crash.
const DUMP_CLOCK_TOLERANCE_MS = 2_000;
// Crashpad may still be writing a dump whose mtime is younger than this.
const DUMP_SETTLE_MS = 2_000;
const MAX_DUMP_BYTES = 64 * 1024 * 1024;
// Crashpad keeps at most a few dozen dumps; remembering more claimed paths than that is waste.
const MAX_CLAIMED_DUMPS = 64;

type CaptureState = { dumpDirectory: string; startedAtMs: number };

let capture: CaptureState | null = null;
let shuttingDown = false;
// Reads in flight, never evicted; claimed history, bounded.
const reservedDumpPaths = new Set<string>();
const claimedDumpPaths = new Set<string>();

export type CrashpadCaptureOptions = {
  /** False when another owner (Sentry's minidump integration) already started the handler; local dump reading then stays off. */
  startHandler: boolean;
  dumpDirectory?: string;
  now?: () => number;
};

export type CrashpadHandler = {
  start: (options: CrashReporterStartOptions) => void;
  reportStartFailure: (error: Error) => void;
};

const electronCrashpad: CrashpadHandler = {
  start: (options) => crashReporter.start(options),
  reportStartFailure: (error) =>
    log.error('[oom-diagnostics] Crashpad start failed; renderer OOM evidence unavailable', error),
};

/**
 * Starts Crashpad with upload off so a dev build gets a local minidump for every renderer death,
 * and records where the dumps land. When another owner (Sentry) already started the handler, its
 * pipeline carries the evidence and local dump reading stays off. Must run before the first
 * renderer is created; Electron does not monitor renderers spawned earlier.
 */
export function startCrashpadCapture(
  options: CrashpadCaptureOptions,
  handler: CrashpadHandler = electronCrashpad,
): boolean {
  if (capture) return true;
  if (!options.startHandler) return true;
  try {
    handler.start({ uploadToServer: false, ignoreSystemCrashHandler: false, compress: false });
  } catch (error) {
    handler.reportStartFailure(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
  capture = {
    dumpDirectory: options.dumpDirectory ?? app.getPath('crashDumps'),
    startedAtMs: (options.now ?? Date.now)(),
  };
  return true;
}

/** A death observed during quit must not wait on a dump; the pending poll resolves empty. */
export function markCrashpadShutdown(): void {
  shuttingDown = true;
}

export function _resetCrashpadCaptureForTests(): void {
  capture = null;
  shuttingDown = false;
  reservedDumpPaths.clear();
  claimedDumpPaths.clear();
}

function dumpDirectories(root: string): string[] {
  if (process.platform === 'win32') return [path.join(root, 'reports')];
  const directories = [path.join(root, 'completed')];
  if (process.platform === 'darwin') directories.push(path.join(root, 'pending'));
  return directories;
}

// Crashpad names a dump by its report id and keeps that name when it promotes pending -> completed.
type DumpCandidate = { filePath: string; reportName: string; mtimeMs: number; size: number };

async function listDumpsOldestFirst(root: string): Promise<DumpCandidate[]> {
  const candidates: DumpCandidate[] = [];
  for (const directory of dumpDirectories(root)) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.dmp')) continue;
      const filePath = path.join(directory, name);
      try {
        const stats = await stat(filePath);
        candidates.push({ filePath, reportName: name, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        // Crashpad renames dumps as it promotes them; a vanished file is normal.
      }
    }
  }
  return candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export type FreshMinidump = { path: string; annotations: CrashpadAnnotations };

export type FindMinidumpOptions = {
  /** Claims only a dump this death can own; a rejected dump stays available to other deaths. */
  accept: (annotations: CrashpadAnnotations) => boolean;
  /** A dump that cannot be read is claimed so no death re-reads it, and reported here. */
  onMalformed?: (path: string) => void;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function claimDumpPath(reportName: string): void {
  claimedDumpPaths.add(reportName);
  for (const oldest of claimedDumpPaths) {
    if (claimedDumpPaths.size <= MAX_CLAIMED_DUMPS) break;
    claimedDumpPaths.delete(oldest);
  }
}

/** Null when the file went away between listing and reading; Crashpad promotes dumps by renaming. */
async function readDumpBytes(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

type DumpSearch = {
  dumpDirectory: string;
  floorMs: number;
  now: () => number;
  rejected: Set<string>;
};

function isCandidate(dump: DumpCandidate, search: DumpSearch): boolean {
  if (dump.mtimeMs < search.floorMs || dump.size > MAX_DUMP_BYTES) return false;
  if (reservedDumpPaths.has(dump.reportName) || claimedDumpPaths.has(dump.reportName)) return false;
  if (search.rejected.has(dump.reportName)) return false;
  return search.now() - dump.mtimeMs >= DUMP_SETTLE_MS;
}

/** Claims the dump for this death, or leaves it rejected, claimed as malformed, or untouched. */
async function examineDump(
  dump: DumpCandidate,
  search: DumpSearch,
  options: FindMinidumpOptions,
): Promise<FreshMinidump | null> {
  if (!isCandidate(dump, search)) return null;
  // Reserve before the read so a concurrent death's search cannot read the same dump.
  reservedDumpPaths.add(dump.reportName);
  try {
    const bytes = await readDumpBytes(dump.filePath);
    if (bytes === null) return null;
    const annotations = readCrashpadAnnotations(bytes);
    if (annotations === null) {
      claimDumpPath(dump.reportName);
      options.onMalformed?.(dump.filePath);
      return null;
    }
    if (!options.accept(annotations)) {
      search.rejected.add(dump.reportName);
      return null;
    }
    claimDumpPath(dump.reportName);
    return { path: dump.filePath, annotations };
  } finally {
    reservedDumpPaths.delete(dump.reportName);
  }
}

async function claimFirstOwnedDump(
  search: DumpSearch,
  options: FindMinidumpOptions,
): Promise<FreshMinidump | null> {
  for (const dump of await listDumpsOldestFirst(search.dumpDirectory)) {
    const claimed = await examineDump(dump, search, options);
    // Quit may have begun during the listing or the read; nothing is confirmed on the way out.
    if (shuttingDown) return null;
    if (claimed) return claimed;
  }
  return null;
}

/** Oldest settled dump written for this death that `accept` owns; null once the wait ends. */
export async function findFreshMinidump(
  crashedAtMs: number,
  options: FindMinidumpOptions,
): Promise<FreshMinidump | null> {
  if (!capture) return null;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const search: DumpSearch = {
    dumpDirectory: capture.dumpDirectory,
    floorMs: Math.max(crashedAtMs - DUMP_CLOCK_TOLERANCE_MS, capture.startedAtMs),
    now,
    rejected: new Set(),
  };
  const deadline = now() + (options.timeoutMs ?? DUMP_WAIT_TIMEOUT_MS);
  while (!shuttingDown) {
    const claimed = await claimFirstOwnedDump(search, options);
    if (claimed || shuttingDown) return claimed;
    if (now() >= deadline) return null;
    await sleep(options.pollMs ?? DUMP_POLL_INTERVAL_MS);
  }
  return null;
}
