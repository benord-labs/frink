/**
 * Managed-policy reader for the v2 permissions dispatcher. Loads a JSON file
 * shipped by an enterprise admin (or local power-user); empty doc on absent /
 * unreadable / malformed file so a broken policy never blocks the user.
 *
 * Cache shape: `Map<string, Promise<PermissionsDoc>>` keyed by absolute path.
 * Caching the Promise (not the value) memoises in-flight reads so concurrent
 * first-callers share a single fs round-trip. Restart to reload — explicit
 * non-goal to hot-reload.
 *
 * Trusted-on-first-read: any local user who can write the policy path can
 * grant themselves broader permissions. Cryptographic verification is a
 * future-tier follow-up.
 *
 * Ticket 07 of the permissions overhaul.
 */

import { readFile } from 'node:fs/promises';
import log from 'electron-log';
import type { PermissionsDoc } from './types';

const POLICY_FILE_PATHS = {
  darwin: '/Library/Application Support/Frink/managed-permissions.json',
  linux: '/etc/frink/managed-permissions.json',
  win32: 'C:\\ProgramData\\Frink\\managed-permissions.json',
} as const;

/** Resolved each call so test/CI overrides via env var take effect. */
export function getPolicyFilePath(): string {
  const override = process.env.FRINK_MANAGED_PERMISSIONS_PATH;
  if (override) return override;
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return POLICY_FILE_PATHS[p];
  return POLICY_FILE_PATHS.linux;
}

const inflight = new Map<string, Promise<PermissionsDoc>>();

function emptyDoc(): PermissionsDoc {
  return { allow: [], deny: [], ask: [] };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is string => typeof e === 'string');
}

async function loadPolicy(path: string): Promise<PermissionsDoc> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isErrnoException(err)) {
      if (err.code === 'ENOENT') return emptyDoc();
      if (err.code === 'EACCES') {
        log.error('[permission] policy file unreadable (EACCES)', { path });
        return emptyDoc();
      }
      log.warn('[permission] policy file read failed', { path, code: err.code });
      return emptyDoc();
    }
    log.warn('[permission] policy file read failed', { path });
    return emptyDoc();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('[permission] policy file malformed JSON', { path });
    return emptyDoc();
  }

  const wrapper = parsed as { permissions?: unknown } | null;
  const permissions =
    wrapper && typeof wrapper === 'object' && wrapper.permissions ? wrapper.permissions : null;
  if (!permissions || typeof permissions !== 'object') return emptyDoc();

  const p = permissions as { allow?: unknown; deny?: unknown; ask?: unknown };
  const doc: PermissionsDoc = {
    allow: pickStringArray(p.allow),
    deny: pickStringArray(p.deny),
    ask: pickStringArray(p.ask),
  };

  log.info('[permission] managed policy loaded', {
    path,
    allow: doc.allow.length,
    deny: doc.deny.length,
    ask: doc.ask.length,
  });

  return doc;
}

/**
 * Reads the managed policy file. Empty doc if absent, unreadable, or malformed —
 * never throws, never blocks. Concurrent first-callers share one fs round-trip.
 */
export async function getPolicyDoc(path: string = getPolicyFilePath()): Promise<PermissionsDoc> {
  const cached = inflight.get(path);
  if (cached) return cached;
  const promise = loadPolicy(path);
  inflight.set(path, promise);
  return promise;
}

/** Test helper. */
export function __resetPolicyCache(): void {
  inflight.clear();
}
