import { isTransformable } from './is-transformable';

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-clone `data` and rewrite every plain-object key with `fn`. Arrays
 * preserve numeric indices. Non-plain objects (Date, Map, Set, Buffer,
 * Uint8Array, RegExp, class instances) are returned by reference.
 *
 * Adapted from axios-case-converter's `transformObjectUsingCallbackRecursive`
 * (MIT). Uses `{}` instead of `Object.create(null)` so output objects keep
 * `Object.prototype` (renderer code calls `hasOwnProperty`, `toString`, etc.).
 * Prototype-pollution-relevant keys (`__proto__`, `constructor`, `prototype`)
 * are skipped — untrusted HTTP response payloads pass through this walker
 * before the renderer consumes them.
 */
export function deepTransformKeys<T = unknown>(data: T, fn: (key: string) => string): T {
  if (!isTransformable(data)) return data;

  if (Array.isArray(data)) {
    const out: unknown[] = [];
    for (let i = 0; i < data.length; i++) {
      out[i] = deepTransformKeys(data[i], fn);
    }
    return out as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as object)) {
    if (POLLUTION_KEYS.has(key)) continue;
    out[fn(key)] = deepTransformKeys(value, fn);
  }
  return out as T;
}
