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

export function writeCache<T>(key: string, deviceId: string, data: T, updatedAt = Date.now()) {
  entries.delete(key);
  entries.set(key, { deviceId, data, updatedAt });
  const [oldest] = entries.keys();
  if (entries.size > CACHE_LIMIT && oldest !== undefined) entries.delete(oldest);
}

/** Drops one computer's answers, or every answer when no computer is named. */
export function clearCache(deviceId?: string) {
  for (const [key, entry] of entries)
    if (deviceId === undefined || entry.deviceId === deviceId) entries.delete(key);
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
  const values = keys.map((key) => shareValue(prev[key], next[key]));
  const same =
    Object.keys(prev).length === keys.length &&
    keys.every((key, index) => key in prev && values[index] === prev[key]);
  return same ? prev : Object.fromEntries(keys.map((key, index) => [key, values[index]]));
}
