/**
 * Shared in-memory cache for MCP tool lists, used by BOTH UI discovery paths:
 * the tRPC `claude` router's `getAllMcpConfig` (Settings list, keyed
 * `${projectPath ?? GLOBAL_MCP_PATH}:${name}` via `claudeMcpCacheKey`) and the
 * `mcp` router's `getAggregatedMcpInfo` (keyed `agg:${name}`). The two callers
 * use disjoint key namespaces and their own fingerprint fn, so a key is only
 * ever read with the fingerprint that wrote it — the module treats `fingerprint`
 * as an opaque token and never cross-reads namespaces.
 *
 * Lives in its own module so the routers and `mcp-auth.ts` (which busts the
 * cache after writing rotated OAuth tokens) can import without a circular
 * dependency.
 *
 * Negative caching: a failed/empty probe IS cached, but only for a short window
 * (`CLAUDE_TOOLS_NEGATIVE_TTL_MS`) — long enough to stop a dead server
 * re-probing at full cost on every load, short enough that a recovered server
 * isn't shown empty for the full success TTL.
 *
 * Notes on which mutation paths intentionally do NOT call invalidate:
 *  - A `frink` entry in `~/.claude.json` is filtered out of
 *    `getAllMcpConfig` results, so it cannot be cached here.
 *  - `tryMirrorFrinkMcpUrlToClaudeJson` only runs from inside
 *    `startMcpOAuth`, which itself triggers an invalidation at the end of
 *    its OAuth flow. If it ever gets called independently in the future,
 *    that caller must invalidate.
 */

import { createHash } from 'node:crypto';
import { GLOBAL_MCP_PATH, type McpServerConfig } from '../claude-config';

export const CLAUDE_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;
export const CLAUDE_TOOLS_NEGATIVE_TTL_MS = 30 * 1000;

/** A hit holds for the full TTL; an empty/failed probe only for the negative window. */
function entryTtlMs(tools: string[]): number {
  return tools.length === 0 ? CLAUDE_TOOLS_NEGATIVE_TTL_MS : CLAUDE_TOOLS_CACHE_TTL_MS;
}

type CacheEntry = {
  tools: string[];
  fetchedAt: number;
  fingerprint: string;
  /** Monotonic generation, bumped on every write — see `refreshClaudeToolsCache`. */
  revision: number;
};

const cache = new Map<string, CacheEntry>();

/**
 * Process-wide write counter. A background refresh captures the revision of the entry it
 * was launched for, so it can tell "still the entry I probed" from "a newer entry that
 * merely has the same fingerprint" (which a config cycling A → B → A produces).
 */
let cacheRevision = 0;

/** Single source of truth for cache keys — `${projectPath ?? GLOBAL_MCP_PATH}:${serverName}`. */
export function claudeMcpCacheKey(projectPath: string | null, serverName: string): string {
  return `${projectPath ?? GLOBAL_MCP_PATH}:${serverName}`;
}

/**
 * A short one-way hash of a string map's entries (keys AND values), or the empty
 * string for a missing/empty map. Stored in the fingerprint, never the raw value —
 * a credential VALUE never lives in the cache or on disk.
 */
export function hashConfigValues(map: Record<string, string> | undefined): string {
  const entries = Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/** Compose already-sanitized config and credential parts into an opaque cache fingerprint. */
export function buildMcpToolFingerprint(
  config: { command?: string; args?: string[]; url?: string },
  credentials: { env: string; oauth: string; headers: string },
): string {
  return `${config.command ?? ''}|${(config.args ?? []).join(',')}|${config.url ?? ''}|${credentials.env}|${credentials.oauth}|${credentials.headers}`;
}

/**
 * Hash inputs that affect the tool list returned by an MCP server. If any change
 * between calls, the cached entry is treated as stale and re-probed.
 *
 * Credential VALUES are hashed (env, headers, the OAuth token), not just their
 * key names — a rotated token or a changed secret under the same key CAN point at
 * a different account/scope with a different tool set, so a rotation must change
 * the fingerprint. This makes a stale write from a probe that raced a rotation
 * self-invalidating (the next read computes the new fingerprint and misses it),
 * so explicit invalidate is only needed for immediacy, not correctness.
 */
export function claudeConfigFingerprint(config: McpServerConfig): string {
  const headers = hashConfigValues(config.headers as Record<string, string> | undefined);
  const env = hashConfigValues(config.env as Record<string, string> | undefined);
  const oauth = config._oauth?.accessToken
    ? createHash('sha256').update(config._oauth.accessToken).digest('hex').slice(0, 16)
    : '';
  return buildMcpToolFingerprint(config, { env, oauth, headers });
}

/**
 * Reads a fingerprint-matched entry regardless of freshness, tagging whether it is
 * past its TTL. A fingerprint mismatch (config/credential changed) stays a hard miss —
 * never serve another config's tools. Powers stale-while-revalidate on the A-path:
 * a caller may serve `stale` tools instantly and re-probe in the background, which is
 * safe precisely because a real config change already misses on the fingerprint.
 */
export function readClaudeToolsCacheEntry(
  cacheKey: string,
  fingerprint: string,
): { tools: string[]; stale: boolean; revision: number } | null {
  const entry = cache.get(cacheKey);
  if (!entry || entry.fingerprint !== fingerprint) return null;
  return {
    tools: entry.tools,
    stale: Date.now() - entry.fetchedAt >= entryTtlMs(entry.tools),
    revision: entry.revision,
  };
}

/** Returns the cached tools if fresh (per-entry TTL) and the fingerprint matches, else `null`. */
export function readClaudeToolsCache(cacheKey: string, fingerprint: string): string[] | null {
  const entry = readClaudeToolsCacheEntry(cacheKey, fingerprint);
  return entry && !entry.stale ? entry.tools : null;
}

/**
 * Caches a probe result. An empty result (timeout/failure/genuinely-toolless) is
 * cached too, but its shorter negative TTL (see `entryTtlMs`) means it re-probes
 * soon rather than locking out for the full success window — this is what stops
 * a dead server re-probing at full cost on every load.
 */
export function writeClaudeToolsCache(
  cacheKey: string,
  tools: string[],
  fingerprint: string,
): void {
  if (tools.length === 0) {
    // A negative (empty/failed) result must not clobber a still-fresh success for
    // the same config: two overlapping same-key probes can race, so a slower one
    // that returns empty would otherwise erase the faster one's tools. Success is
    // authoritative; a later empty is transient — leave the hit in place. (A write
    // for a DIFFERENT config has a different fingerprint and is allowed through —
    // a rotated credential legitimately replaces the old tool list.)
    const existing = cache.get(cacheKey);
    if (
      existing &&
      existing.tools.length > 0 &&
      existing.fingerprint === fingerprint &&
      Date.now() - existing.fetchedAt < CLAUDE_TOOLS_CACHE_TTL_MS
    ) {
      return;
    }
  }
  cacheRevision += 1;
  cache.set(cacheKey, { tools, fetchedAt: Date.now(), fingerprint, revision: cacheRevision });
}

/**
 * Background-refresh write: updates an entry ONLY if it is still the exact entry the
 * revalidation was launched for — same `fingerprint` AND same `revision`.
 *
 * A stale-while-revalidate probe captures both when it starts. By the time it returns, a
 * newer cold probe may have replaced the entry (or an invalidate cleared the key); writing
 * blindly would clobber that fresher entry, forcing a needless re-probe and regressing to
 * empty if the server is momentarily down. The fingerprint alone is not enough: a config
 * cycling A → B → A leaves a NEWER entry carrying the ORIGINAL fingerprint, so a late
 * refresh would pass a fingerprint-only check and overwrite good data with obsolete tools.
 * The revision is bumped on every write, so any intervening write is detected.
 */
export function refreshClaudeToolsCache(
  cacheKey: string,
  tools: string[],
  fingerprint: string,
  revision: number,
): void {
  const existing = cache.get(cacheKey);
  if (!existing || existing.fingerprint !== fingerprint || existing.revision !== revision) return;
  writeClaudeToolsCache(cacheKey, tools, fingerprint);
}

/**
 * Drops a cached entry (or every entry when called with no argument). Correctness
 * no longer depends on this: the value-sensitive fingerprint self-invalidates a
 * stale entry on the next read. It stays for immediacy (clear now, don't wait for
 * the next read to miss) and for explicit clears (server delete / importer sweep).
 *
 * Note: this does NOT touch `workingMcpServers` in `claude.ts` — that map is
 * cleared at the start of every `getAllMcpConfig` invocation and is "not
 * consumed at session start today" (see comment near its declaration). If a
 * future caller starts reading `workingMcpServers` mid-session, this
 * invalidate path needs a matching reset there to avoid serving an old
 * `false` after a token rotation.
 */
export function invalidateClaudeMcpToolsCache(cacheKey?: string): void {
  if (cacheKey) {
    cache.delete(cacheKey);
  } else {
    cache.clear();
  }
}

/** Test-only: lets vitest assert the cache is empty between runs. */
export function _resetClaudeToolsCacheForTests(): void {
  cache.clear();
}
