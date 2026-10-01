import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { compareVersionQuad, parseVersionQuad } from '../auto-updater';

/**
 * Version guard for the bundled Claude Code CLI (`resources/bin/VERSION`).
 *
 * The bundled binary validates `--effort` against a baked-in enum, so a stale binary rejects a
 * newer level at arg-parse and crashes the executor (`--effort xhigh` on < 2.1.173 →
 * `argument 'xhigh' is invalid`). Model IDs are free-form passthrough, but the API can require a
 * minimum CLI version per model (Fable 5.1 needs ≥ 2.1.251) and answers with a clear 400 naming the
 * version — no crash, so no clamp; `bun run claude:download` refreshes a stale local binary. The
 * only effort level that can outrun the bundled binary is `xhigh` (added at 2.1.173, after `max`);
 * we clamp it to `high` when the binary predates it — or when we can't confirm the version at all
 * (fail closed, since a crash is worse than dropping to `high`).
 */
const XHIGH_MIN_VERSION: [number, number, number, number] = [2, 1, 173, 0];
/** First CLI whose `ultracode` setting runs at any effort instead of forcing xhigh. */
const ULTRA_ANY_EFFORT_MIN_VERSION: [number, number, number, number] = [2, 1, 284, 0];

let cachedVersion: string | null = null;

/**
 * First line of `resources/bin/VERSION`; null if absent/unreadable. A *successful* read is cached
 * (the path never changes); a null result is NOT cached, so a one-off fs hiccup only affects one
 * spawn (the next re-reads) instead of clamping effort for the whole session.
 */
export function getBundledClaudeVersion(): string | null {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const versionPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bin/VERSION')
      : path.join(app.getAppPath(), 'resources/bin/VERSION');
    cachedVersion = existsSync(versionPath)
      ? readFileSync(versionPath, 'utf-8').split('\n')[0]?.trim() || null
      : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/** A value must look like a leading `X.Y.Z` semver before we trust the numeric compare. */
const LEADING_SEMVER = /^\d+\.\d+\.\d+/;

/** Whether the bundled CLI is known to accept `--effort xhigh` (≥ 2.1.173). A VERSION that is not
 * a leading semver (download-claude-binary.mjs always writes one) fails closed to `high`. */
export function claudeVersionSupportsXhigh(version: string | null): boolean {
  return versionAtLeast(version, XHIGH_MIN_VERSION);
}

/** Whether the bundled CLI runs Ultra (`ultracode`) at any effort; an unreadable VERSION fails closed. */
export function claudeVersionSupportsUltra(
  version: string | null = getBundledClaudeVersion(),
): boolean {
  return versionAtLeast(version, ULTRA_ANY_EFFORT_MIN_VERSION);
}

function versionAtLeast(version: string | null, min: [number, number, number, number]): boolean {
  if (!version || !LEADING_SEMVER.test(version)) return false;
  return compareVersionQuad(parseVersionQuad(version), min) >= 0;
}

/**
 * Downgrade `xhigh` → `high` when the bundled binary can't run it, so selecting an xhigh tier on a
 * stale binary degrades gracefully instead of crashing the executor. Every other level is safe on
 * every bundled version. `version` is injectable for tests; defaults to the bundled binary's.
 */
export function clampEffortForBundledBinary(
  effort: string | undefined,
  version: string | null = getBundledClaudeVersion(),
): string | undefined {
  if (effort === 'xhigh' && !claudeVersionSupportsXhigh(version)) return 'high';
  return effort;
}
