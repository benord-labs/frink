import { basename, join, relative, sep } from 'node:path';
import { app } from 'electron';
import type { UsageHistory } from '../../../../shared/types/usage-history';
import { resolveCodexHome } from '../../credentials/detect-codex';
import { captureMainException } from '../../sentry/init';
import { summarizeUsage } from './aggregate';

export { getUsageActivity } from './activity';
import { type CacheEntry, loadScanCache, saveScanCache, type ScanCache } from './cache';
import {
  listTranscriptFiles,
  readCodexOrigin,
  readTranscript,
  type TranscriptFile,
} from './reader';
import type { UsageProvider } from './transcripts';

/** Re-scan at most this often; a scan re-reads only transcripts that changed. */
const RESCAN_MS = 60_000;

/** Injection seams for tests; production keeps the defaults. */
export const usageHistoryDeps = {
  /** Frink runs each Claude chat with its own CLAUDE_CONFIG_DIR here, so all of it is Frink's. */
  claudeRoot: (): string => join(app.getPath('userData'), 'claude-sessions'),
  /** Frink never overrides CODEX_HOME, so its rollouts sit beside every other Codex client's. */
  codexRoot: (): string => join(resolveCodexHome(), 'sessions'),
  cachePath: (): string => join(app.getPath('userData'), 'usage-history-cache.json'),
  now: (): Date => new Date(),
};

/** Loaded once and shared, so concurrent first calls never each start from their own copy. */
let cacheLoad: Promise<ScanCache> | null = null;
let summary: UsageHistory | null = null;
let scanning: Promise<void> | null = null;
let lastScanAt = 0;

/** The chat a Claude transcript belongs to: its `claude-sessions/<subChatId>` directory. */
function claudeConversation(path: string): string {
  return relative(usageHistoryDeps.claudeRoot(), path).split(sep)[0] ?? path;
}

/** A changed Codex rollout: skip one another app started (verdict kept, content never read), else
 * read it into its conversation (null for a subagent run, whose tokens still count). */
async function codexTarget(
  cache: ScanCache,
  file: TranscriptFile,
  cached: CacheEntry | undefined,
): Promise<{ read: false; changed: boolean } | { read: true; conversation: string | null }> {
  if (cached?.position === null) {
    cache.set(file.path, { ...cached, size: file.size, mtimeMs: file.mtimeMs });
    return { read: false, changed: false };
  }
  if (cached) return { read: true, conversation: cached.conversation };
  const origin = await readCodexOrigin(file.path);
  if (!origin) return { read: false, changed: false };
  if (!origin.fromFrink) {
    cache.set(file.path, {
      size: file.size,
      mtimeMs: file.mtimeMs,
      position: null,
      conversation: null,
      records: [],
    });
    return { read: false, changed: true };
  }
  return { read: true, conversation: origin.subagent ? null : basename(file.path) };
}

function entryAfterRead(
  file: TranscriptFile,
  read: NonNullable<Awaited<ReturnType<typeof readTranscript>>>,
  conversation: string | null,
  cached: CacheEntry | undefined,
): CacheEntry {
  const earlier = read.resumed ? (cached?.records ?? []) : [];
  return {
    size: file.size,
    mtimeMs: file.mtimeMs,
    position: read.position,
    conversation,
    records: [...earlier, ...read.records],
  };
}

/** Re-reads one transcript if it changed since the cache saw it. True when the cache changed. */
async function scanFile(
  cache: ScanCache,
  file: TranscriptFile,
  provider: UsageProvider,
): Promise<boolean> {
  const cached = cache.get(file.path);
  if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return false;
  const target =
    provider === 'claude'
      ? { read: true as const, conversation: claudeConversation(file.path) }
      : await codexTarget(cache, file, cached);
  if (!target.read) return target.changed;
  const read = await readTranscript(file.path, provider, cached?.position ?? undefined);
  if (read) cache.set(file.path, entryAfterRead(file, read, target.conversation, cached));
  return read !== null;
}

/** Brings `cache` up to date with the transcripts on disk. True when anything changed. */
async function scanInto(cache: ScanCache): Promise<boolean> {
  const roots: Array<[UsageProvider, string]> = [
    ['claude', usageHistoryDeps.claudeRoot()],
    ['codex', usageHistoryDeps.codexRoot()],
  ];
  const seen = new Set<string>();
  const unreadable: string[] = [];
  let changed = false;
  for (const [provider, root] of roots) {
    const files = await listTranscriptFiles(root);
    if (!files) unreadable.push(root);
    for (const file of files ?? []) {
      seen.add(file.path);
      changed = (await scanFile(cache, file, provider)) || changed;
    }
  }
  // A root that couldn't be listed keeps its entries: a failed read is not a deletion.
  const keep = (path: string) => seen.has(path) || unreadable.some((root) => path.startsWith(root));
  for (const path of cache.keys()) {
    if (!keep(path)) changed = cache.delete(path) || changed;
  }
  return changed;
}

function summarize(cache: ScanCache): UsageHistory {
  const transcripts = [...cache.values()].filter((entry) => entry.records.length > 0);
  return summarizeUsage(transcripts, usageHistoryDeps.now());
}

async function refresh(current: ScanCache): Promise<void> {
  lastScanAt = usageHistoryDeps.now().getTime();
  try {
    const changed = await scanInto(current);
    summary = summarize(current);
    if (changed) await saveScanCache(usageHistoryDeps.cachePath(), current);
  } catch (err) {
    captureMainException(err, { surface: 'usage-history-scan' });
  }
}

/**
 * Frink usage history for Settings → Usage. Answers from the last result at once and re-scans
 * in the background (one scan at a time); only a first-ever open with no saved cache waits.
 */
export async function getUsageHistory(): Promise<UsageHistory> {
  // Only the saved cache or a finished scan sets `summary`, never a scan still in progress.
  cacheLoad ??= loadScanCache(usageHistoryDeps.cachePath()).then((loaded) => {
    if (loaded.size > 0) summary = summarize(loaded);
    return loaded;
  });
  const current = await cacheLoad;
  if (!scanning && usageHistoryDeps.now().getTime() - lastScanAt >= RESCAN_MS) {
    scanning = refresh(current).finally(() => {
      scanning = null;
    });
  }
  if (summary) return summary;
  await scanning;
  return summary ?? summarize(current);
}

/** Test-only: forget the cache and the last result. */
export function resetUsageHistoryForTests(): void {
  cacheLoad = null;
  summary = null;
  scanning = null;
  lastScanAt = 0;
}
