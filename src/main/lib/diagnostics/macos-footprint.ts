import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const FOOTPRINT_BIN = '/usr/bin/footprint';
/**
 * Generous: walking a heavily swapped process blocks on paging for seconds, so a tight timeout
 * misses exactly the runaway renderer. Stays below the probe interval so probes never overlap.
 */
const PROBE_TIMEOUT_MS = 30_000;
const BYTES_PER_KB = 1024;

const byteCount = z.number().finite().nonnegative();

/**
 * `auxiliary.phys_footprint` is the figure vmmap prints as "Physical footprint". The sibling
 * top-level `footprint` key is a dirty-page accounting number and differs from it.
 */
const footprintProcessSchema = z.object({
  pid: z.number().int(),
  auxiliary: z.object({
    phys_footprint: byteCount,
    phys_footprint_peak: byteCount,
  }),
});

const footprintDocumentSchema = z.object({
  // A macOS release defaulting to page units would otherwise read as bytes and under-report by the
  // page size — the same silent wrongness this module exists to remove.
  'bytes per unit': z.literal(1),
  // footprint(1) degrades to partial data rather than failing, so anything reported here rejects
  // the whole document.
  errors: z.array(z.unknown()).max(0),
  warnings: z.array(z.unknown()).max(0),
  // A process that exited between the metrics read and the probe is simply absent, and an entry
  // the schema cannot read is dropped rather than failing its siblings.
  processes: z.array(footprintProcessSchema.nullable().catch(null)),
  // Swap is reported once for the invocation, de-duplicated across the selected processes.
  summary: z.object({ total: z.object({ swapped: byteCount.optional() }).optional() }).optional(),
});

type RendererFootprint = { physFootprintKb: number; peakKb: number };

export type FootprintSample = {
  perPid: Map<number, RendererFootprint>;
  /**
   * De-duplicated across the probed processes. footprint(1) exposes no per-process swap figure,
   * so this can never be attributed to one pid.
   */
  swappedKb: number | undefined;
};

function toKb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_KB);
}

/**
 * An absent pid is not an error: footprint(1) silently omits a process that exited mid-probe.
 * Callers decide whether partial coverage counts as measured.
 */
export function parseFootprintJson(raw: string): FootprintSample | null {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = footprintDocumentSchema.safeParse(document);
  if (!parsed.success) return null;

  const perPid = new Map<number, RendererFootprint>();
  for (const entry of parsed.data.processes) {
    if (!entry) continue;
    perPid.set(entry.pid, {
      physFootprintKb: toKb(entry.auxiliary.phys_footprint),
      peakKb: toKb(entry.auxiliary.phys_footprint_peak),
    });
  }
  if (perPid.size === 0) return null;

  const swappedBytes = parsed.data.summary?.total?.swapped;
  return { perPid, swappedKb: swappedBytes === undefined ? undefined : toKb(swappedBytes) };
}

/**
 * Physical footprint per process, including the compressed and swapped pages working set omits.
 * Fails open to null on any failure; output is never logged because it carries process names.
 */
export async function readRendererFootprints(pids: number[]): Promise<FootprintSample | null> {
  if (process.platform !== 'darwin' || pids.length === 0) return null;

  const target = path.join(os.tmpdir(), `frink-footprint-${randomUUID()}.json`);
  try {
    await execFileAsync(
      FOOTPRINT_BIN,
      [
        '--noCategories',
        '-f',
        'bytes',
        '-j',
        target,
        ...pids.flatMap((pid) => ['-p', String(pid)]),
      ],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return parseFootprintJson(await readFile(target, 'utf8'));
  } catch {
    return null;
  } finally {
    await unlink(target).catch(() => undefined);
  }
}
