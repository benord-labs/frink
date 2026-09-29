import { describe, expect, it } from 'vitest';
import { shareEqualDeep } from './structural-sharing';

// superjson revives Dates, so every chat/project/task payload carries them.
const chat = (id: string, updatedAt: string, name = 'Chat') => ({
  id,
  name,
  updatedAt: new Date(updatedAt),
  pinnedAt: null,
});

describe('shareEqualDeep', () => {
  it('keeps the previous tree when a refetch returns equal data containing Dates', () => {
    const prev = { chats: [chat('a', '2026-09-01'), chat('b', '2026-09-02')], hasMore: false };
    const next = { chats: [chat('a', '2026-09-01'), chat('b', '2026-09-02')], hasMore: false };

    expect(shareEqualDeep(prev, next)).toBe(prev);
  });

  it('re-mints only the changed branch and shares every unchanged sibling', () => {
    const prev = [chat('a', '2026-09-01'), chat('b', '2026-09-02')];
    const next = [chat('a', '2026-09-01'), chat('b', '2026-09-03')];

    const shared = shareEqualDeep(prev, next) as typeof prev;

    expect(shared).not.toBe(prev);
    expect(shared[0]).toBe(prev[0]);
    expect(shared[1]).not.toBe(prev[1]);
    expect(shared[1]).toEqual(next[1]);
    expect(shared[1].updatedAt).toBe(next[1].updatedAt);
  });

  it('keeps an equal Date instance but takes a changed one', () => {
    const a = new Date('2026-09-01T10:00:00Z');
    expect(shareEqualDeep(a, new Date(a.getTime()))).toBe(a);
    const later = new Date('2026-09-01T10:00:01Z');
    expect(shareEqualDeep(a, later)).toBe(later);
  });

  it('treats an Invalid Date as unequal rather than sharing it', () => {
    const bad = new Date('not a date');
    const next = new Date('not a date');
    expect(shareEqualDeep(bad, next)).toBe(next);
  });

  it('detects added, removed and undefined-valued keys', () => {
    const prev = { a: 1, b: undefined as number | undefined };
    expect(shareEqualDeep(prev, { a: 1 })).not.toBe(prev);
    expect(shareEqualDeep({ a: 1 }, { a: 1, b: undefined })).toEqual({ a: 1, b: undefined });
    expect(shareEqualDeep(prev, { a: 1, b: undefined })).toBe(prev);
  });

  it('detects array growth and shrinkage', () => {
    const prev = [1, 2];
    expect(shareEqualDeep(prev, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(shareEqualDeep(prev, [1])).toEqual([1]);
    expect(shareEqualDeep([], [])).toEqual([]);
  });

  it('does not overflow the stack on very deeply nested payloads (TanStack caps depth at 500)', () => {
    const nest = (depth: number) => {
      let node: Record<string, unknown> = { leaf: new Date(0) };
      for (let i = 0; i < depth; i++) node = { child: node };
      return node;
    };
    const next = nest(100_000);
    let shared: unknown;
    expect(() => {
      shared = shareEqualDeep(nest(100_000), next);
    }).not.toThrow();
    // Walk iteratively: a recursive matcher would itself overflow at this depth.
    let node = shared as Record<string, unknown>;
    for (let i = 0; i < 100_000; i++) node = node.child as Record<string, unknown>;
    expect(node.leaf).toEqual(new Date(0));
  });

  it('keeps an own "__proto__" key as data instead of re-prototyping the result', () => {
    const prev = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as Record<string, unknown>;
    const next = JSON.parse('{"__proto__": {"x": 2}, "a": 1}') as Record<string, unknown>;

    const shared = shareEqualDeep(prev, next) as Record<string, unknown>;

    expect(Object.getPrototypeOf(shared)).toBe(Object.prototype);
    expect(Object.hasOwn(shared, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(shared, '__proto__')?.value).toEqual({ x: 2 });
    expect(shareEqualDeep(prev, JSON.parse('{"__proto__": {"x": 1}, "a": 1}'))).toBe(prev);
  });

  it('never treats an array hole and an explicit undefined element as equal', () => {
    const hole = Array(1) as unknown[];
    const explicit = [undefined];

    const fromExplicit = shareEqualDeep(explicit, hole) as unknown[];
    expect(fromExplicit).not.toBe(explicit);
    expect(0 in fromExplicit).toBe(false);

    const fromHole = shareEqualDeep(hole, explicit) as unknown[];
    expect(fromHole).not.toBe(hole);
    expect(0 in fromHole).toBe(true);

    expect(shareEqualDeep(hole, Array(1))).toBe(hole);
  });

  it('never shares across shape changes (array vs object, Date vs string, null vs object)', () => {
    const next = { 0: 'x' };
    expect(shareEqualDeep(['x'], next)).toBe(next);
    expect(shareEqualDeep(new Date(0), '1970-01-01T00:00:00.000Z')).toBe(
      '1970-01-01T00:00:00.000Z',
    );
    expect(shareEqualDeep(null, { a: 1 })).toEqual({ a: 1 });
    expect(shareEqualDeep({ a: 1 }, null)).toBeNull();
  });

  it('returns the new value for non-plain objects such as Map, as the default sharing does', () => {
    const prev = new Map([['a', 1]]);
    const next = new Map([['a', 1]]);
    expect(shareEqualDeep(prev, next)).toBe(next);
  });
});
