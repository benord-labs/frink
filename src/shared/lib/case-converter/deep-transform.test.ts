import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { toCamelKey } from './case-strings';
import { deepTransformKeys } from './deep-transform';

describe('deepTransformKeys', () => {
  it('returns primitives untouched', () => {
    expect(deepTransformKeys(null, toCamelKey)).toBe(null);
    expect(deepTransformKeys(undefined, toCamelKey)).toBe(undefined);
    expect(deepTransformKeys(42, toCamelKey)).toBe(42);
    expect(deepTransformKeys('hello', toCamelKey)).toBe('hello');
    expect(deepTransformKeys(true, toCamelKey)).toBe(true);
  });

  it('rewrites snake_case keys on plain objects', () => {
    const out = deepTransformKeys({ user_id: '1', command_pattern: 'p' }, toCamelKey);
    expect(out).toEqual({ userId: '1', commandPattern: 'p' });
  });

  it('walks nested objects', () => {
    const out = deepTransformKeys({ outer_key: { inner_key: { leaf_key: 'v' } } }, toCamelKey);
    expect(out).toEqual({ outerKey: { innerKey: { leafKey: 'v' } } });
  });

  it('walks arrays of objects and preserves indices', () => {
    const out = deepTransformKeys(
      [{ user_id: '1' }, { user_id: '2' }, { user_id: '3' }],
      toCamelKey,
    );
    expect(out).toEqual([{ userId: '1' }, { userId: '2' }, { userId: '3' }]);
  });

  it('values are NOT transformed (only keys)', () => {
    // Critical: Claude SDK todo statuses like 'in_progress' are values, not keys
    const out = deepTransformKeys({ status: 'in_progress' }, toCamelKey);
    expect(out).toEqual({ status: 'in_progress' });
  });

  it('skips __proto__ keys to prevent prototype pollution', () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "normal_key": "v"}');
    const out = deepTransformKeys(malicious, toCamelKey) as Record<string, unknown>;
    expect(out).toEqual({ normalKey: 'v' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('skips constructor and prototype keys (prototype pollution defense)', () => {
    const malicious = JSON.parse(
      '{"constructor": {"prototype": {"polluted": true}}, "prototype": {"x": 1}, "normal_key": "v"}',
    );
    const out = deepTransformKeys(malicious, toCamelKey) as Record<string, unknown>;
    expect(out).toEqual({ normalKey: 'v' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('output objects retain Object.prototype (regression: NOT Object.create(null))', () => {
    const out = deepTransformKeys({ user_id: '1' }, toCamelKey) as Record<string, unknown>;
    // hasOwnProperty must work — renderer code calls this on tRPC results
    expect(Object.hasOwn(out, 'userId')).toBe(true);
    expect(out instanceof Object).toBe(true);
    expect(Object.prototype.toString.call(out)).toBe('[object Object]');
  });

  it('Date instances pass through by reference', () => {
    const date = new Date('2026-05-04');
    const out = deepTransformKeys({ created_at: date }, toCamelKey) as Record<string, unknown>;
    expect(out.createdAt).toBe(date);
  });

  it('Map instances pass through by reference', () => {
    const map = new Map([['a', 1]]);
    const out = deepTransformKeys({ my_map: map }, toCamelKey) as Record<string, unknown>;
    expect(out.myMap).toBe(map);
  });

  it('Set instances pass through by reference', () => {
    const set = new Set([1, 2, 3]);
    const out = deepTransformKeys({ my_set: set }, toCamelKey) as Record<string, unknown>;
    expect(out.mySet).toBe(set);
  });

  it('Buffer instances pass through by reference', () => {
    const buf = Buffer.from('hello');
    const out = deepTransformKeys({ my_buf: buf }, toCamelKey) as Record<string, unknown>;
    expect(out.myBuf).toBe(buf);
  });

  it('Uint8Array instances pass through by reference', () => {
    const arr = new Uint8Array([1, 2, 3]);
    const out = deepTransformKeys({ my_arr: arr }, toCamelKey) as Record<string, unknown>;
    expect(out.myArr).toBe(arr);
  });

  it('RegExp instances pass through by reference', () => {
    const re = /abc/i;
    const out = deepTransformKeys({ my_re: re }, toCamelKey) as Record<string, unknown>;
    expect(out.myRe).toBe(re);
  });

  it('class instances pass through by reference', () => {
    class Thing {
      constructor(public id: string) {}
    }
    const t = new Thing('x');
    const out = deepTransformKeys({ my_thing: t }, toCamelKey) as Record<string, unknown>;
    expect(out.myThing).toBe(t);
  });

  it('does not mutate the input object', () => {
    const input = { user_id: '1', nested: { foo_bar: 'v' } };
    const snapshot = JSON.stringify(input);
    deepTransformKeys(input, toCamelKey);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('handles empty object and empty array', () => {
    expect(deepTransformKeys({}, toCamelKey)).toEqual({});
    expect(deepTransformKeys([], toCamelKey)).toEqual([]);
  });

  it('idempotent on already-camelCase payload', () => {
    const input = { userId: '1', nested: { fooBar: 'v' } };
    const out = deepTransformKeys(input, toCamelKey);
    expect(out).toEqual(input);
  });

  it('handles realistic DB row shape', () => {
    const dbRow = {
      id: 'p1',
      user_id: 'u1',
      git_remote: 'origin/main',
      folder_id: null,
      command: 'rm -rf',
      command_pattern: 'rm -rf *',
      duration: 'always',
      expires_at: null,
      granted_at: '2026-05-04',
      use_count: 3,
      last_used_at: null,
      status: 'allowed',
    };
    expect(deepTransformKeys(dbRow, toCamelKey)).toEqual({
      id: 'p1',
      userId: 'u1',
      gitRemote: 'origin/main',
      folderId: null,
      command: 'rm -rf',
      commandPattern: 'rm -rf *',
      duration: 'always',
      expiresAt: null,
      grantedAt: '2026-05-04',
      useCount: 3,
      lastUsedAt: null,
      status: 'allowed',
    });
  });
});
