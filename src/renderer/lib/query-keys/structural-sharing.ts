// Default sharing (replaceEqualDeep) stops at Dates, so identical Date-bearing refetches re-minted
// whole payloads and re-rendered every sidebar row per poll (sc-2721). This one shares equal Dates.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function datesEqual(prev: Date, next: Date): boolean {
  const time = prev.getTime();
  return !Number.isNaN(time) && time === next.getTime();
}

// Same bail-out as TanStack's replaceEqualDeep: past this depth take `next` rather than overflow.
const MAX_DEPTH = 500;

/** Own `__proto__` (valid JSON) must be read and written as data, never via the prototype accessor. */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  if (key !== '__proto__') return obj[key];
  return Object.hasOwn(obj, key) ? Object.getOwnPropertyDescriptor(obj, key)?.value : undefined;
}

function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key !== '__proto__') obj[key] = value;
  else
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}

// Indexed loop, not map/every: those skip holes, which would equate a hole with `undefined`.
function shareArrays(prev: unknown[], next: unknown[], depth: number): unknown[] {
  const shared: unknown[] = new Array(next.length);
  let unchanged = prev.length === next.length;
  for (let i = 0; i < next.length; i++) {
    if (i in prev !== i in next) unchanged = false;
    if (!(i in next)) continue;
    shared[i] = shareEqualDeep(prev[i], next[i], depth + 1);
    if (shared[i] !== prev[i]) unchanged = false;
  }
  return unchanged ? prev : shared;
}

function shareObjects(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const shared: Record<string, unknown> = {};
  let unchanged = Object.keys(prev).length === Object.keys(next).length;
  for (const key of Object.keys(next)) {
    const before = ownValue(prev, key);
    const value = shareEqualDeep(before, ownValue(next, key), depth + 1);
    setOwn(shared, key, value);
    if (value !== before || !Object.hasOwn(prev, key)) unchanged = false;
  }
  return unchanged ? prev : shared;
}

/** Structural sharing that returns `prev` (or its unchanged branches) wherever `next` is deep-equal. */
export function shareEqualDeep(prev: unknown, next: unknown, depth = 0): unknown {
  if (prev === next) return prev;
  if (depth > MAX_DEPTH) return next;
  if (prev instanceof Date && next instanceof Date) return datesEqual(prev, next) ? prev : next;
  if (Array.isArray(prev) && Array.isArray(next)) return shareArrays(prev, next, depth);
  if (isPlainObject(prev) && isPlainObject(next)) return shareObjects(prev, next, depth);
  return next;
}
