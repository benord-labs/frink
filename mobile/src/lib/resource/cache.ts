import type { MobileRequest } from '@frink/shared/types/remote/mobile';

type Entry<T> = { deviceId: string; data: T; updatedAt: number };

/** The last answer to each request, kept in memory so a remounted screen draws at once. */
const entries = new Map<string, Entry<unknown>>();
/** Past this many answers the least recently written goes, so a long session stays bounded. */
export const CACHE_LIMIT = 50;

/** One request on one computer: the device, its relay route, and the serialized input. */
export const resourceKey = (deviceId: string, route: string, input: MobileRequest) =>
  JSON.stringify([deviceId, route, input]);

export function readCache<T>(key: string): Entry<T> | undefined {
  // SAFETY: a key serializes its request, and only that request's answer is written under it.
  return entries.get(key) as Entry<T> | undefined;
}

function writeCache<T>(key: string, deviceId: string, data: T, updatedAt: number) {
  entries.delete(key);
  entries.set(key, { deviceId, data, updatedAt });
  const [oldest] = entries.keys();
  if (entries.size > CACHE_LIMIT && oldest !== undefined) entries.delete(oldest);
}

/** Counts clears, so a request can tell whether its computer was cleared after it started. */
let clears = 0;
/** The clear count when each computer, or every computer (`undefined`), was last cleared. */
const cleared = new Map<string | undefined, number>();

/** A writer for a request starting now: it stores nothing once the computer is cleared meanwhile. */
export function cacheWriter(deviceId: string) {
  const started = clears;
  return <T>(key: string, data: T, updatedAt = Date.now()) => {
    if (Math.max(cleared.get(deviceId) ?? 0, cleared.get(undefined) ?? 0) > started) return;
    writeCache(key, deviceId, data, updatedAt);
  };
}

/** Prefetches still on their way, so a screen opened meanwhile waits for one instead of asking twice. */
const prefetching = new Map<string, { deviceId: string; answer: Promise<unknown> }>();

/** Loads an answer before its screen asks, unless it is cached or already on its way. */
export function prefetch<T>(key: string, deviceId: string, load: () => Promise<T>) {
  if (readCache(key) || prefetching.has(key)) return;
  const write = cacheWriter(deviceId);
  const answer = load();
  prefetching.set(key, { deviceId, answer });
  answer
    .then((data) => {
      if (!readCache(key)) write(key, data);
    })
    .catch(() => undefined)
    .finally(() => {
      if (prefetching.get(key)?.answer === answer) prefetching.delete(key);
    });
}

/** The answer a prefetch is still waiting for; every screen asking meanwhile shares it. */
export function prefetched<T>(key: string) {
  // SAFETY: a key serializes its request, and only that request's answer is prefetched under it.
  return prefetching.get(key)?.answer as Promise<T> | undefined;
}

/** Drops one computer's answers and prefetches, or all of them when no computer is named. */
export function clearCache(deviceId?: string) {
  cleared.set(deviceId, ++clears);
  for (const map of [entries, prefetching])
    for (const [key, entry] of map)
      if (deviceId === undefined || entry.deviceId === deviceId) map.delete(key);
}

/** When the cached answer is younger than `interval`, the time it was written. A time ahead of
 *  `now` (the clock stepped back) is not fresh, so the screen reads at once. */
export function freshSince(key: string, interval: number, now = Date.now()) {
  const at = readCache(key)?.updatedAt;
  return at !== undefined && at <= now && now - at < interval ? at : undefined;
}

/** A decoded relay answer: JSON, plus `undefined` for an optional field that is absent. */
export type Json =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Json[]
  | { readonly [key: string]: Json };

type JsonRecord = { readonly [key: string]: Json };

/** Decoded JSON holds only arrays and plain objects, so any non-array object is a record. */
const isRecord = (value: Json): value is JsonRecord =>
  value instanceof Object && !Array.isArray(value);

/** Structural sharing ("replace equal deep"): returns `next`, reusing every deep-equal part of
 * `prev`, so unchanged rows keep their identity and skip re-rendering. */
export function share<T extends Json>(prev: T | undefined, next: T): T {
  // SAFETY: shareValue returns `next` or a deep-equal value built from `prev` and `next`.
  return shareValue(prev, next) as T;
}

function shareValue(prev: Json, next: Json): Json {
  if (prev === next) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) return shareArray(prev, next);
  if (isRecord(prev) && isRecord(next)) return shareRecord(prev, next);
  return next;
}

function shareArray(prev: readonly Json[], next: readonly Json[]): Json {
  const values = next.map((value, index) => shareValue(prev[index], value));
  const same =
    values.length === prev.length && values.every((value, index) => value === prev[index]);
  return same ? prev : values;
}

function shareRecord(prev: JsonRecord, next: JsonRecord): Json {
  const keys = Object.keys(next);
  // Own keys only: an inherited member such as `__proto__` is not part of the previous answer.
  const values = keys.map((key) =>
    shareValue(Object.hasOwn(prev, key) ? prev[key] : undefined, next[key]),
  );
  const same =
    Object.keys(prev).length === keys.length &&
    keys.every((key, index) => Object.hasOwn(prev, key) && values[index] === prev[key]);
  return same ? prev : Object.fromEntries(keys.map((key, index) => [key, values[index]]));
}
