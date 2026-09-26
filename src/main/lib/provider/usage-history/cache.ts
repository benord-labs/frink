import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { type ParsePosition, parsePositionSchema } from './reader';
import type { UsageRecord } from './transcripts';

/** Per-transcript scan cache, persisted so a restart re-reads only changed transcripts. Numbers and
 * ids only, never content; a missing, corrupt or older file is just a cold scan. */

const CACHE_VERSION = 2;

const record = z.object({
  provider: z.enum(['claude', 'codex']),
  timestampMs: z.number(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  dedupeKey: z.string().nullable(),
  tools: z.array(z.string()),
});

const entry = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  /** Null for a Codex rollout another app started: its verdict is kept, its content never read. */
  position: parsePositionSchema.nullable(),
  conversation: z.string().nullable(),
  records: z.array(record),
});

const cacheFile = z.object({
  version: z.literal(CACHE_VERSION),
  files: z.record(z.string(), entry),
});

export type CacheEntry = {
  size: number;
  mtimeMs: number;
  position: ParsePosition | null;
  conversation: string | null;
  records: UsageRecord[];
};
export type ScanCache = Map<string, CacheEntry>;

export async function loadScanCache(path: string): Promise<ScanCache> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return new Map();
  try {
    const parsed = cacheFile.safeParse(JSON.parse(raw));
    return parsed.success ? new Map(Object.entries(parsed.data.files)) : new Map();
  } catch {
    return new Map();
  }
}

/** Written to a sibling temp file then renamed, so a crash mid-write never leaves half a cache. */
export async function saveScanCache(path: string, cache: ScanCache): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(
    temp,
    JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(cache) }),
  );
  await rename(temp, path);
}
