import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_LIMIT,
  cacheWriter,
  clearCache,
  freshSince,
  prefetch,
  prefetched,
  readCache,
  resourceKey,
  share,
  type Json,
} from './cache';
import { CHATS_PAGE, FIRST_PAGES } from './first-pages';

type Message = { id: string; text: string; parts: { kind: string }[] };
type Detail = { activity: string; messages: Message[] };

const message = (id: string, text = `Message ${id}`): Message => ({
  id,
  text,
  parts: [{ kind: 'text' }],
});
const detail = (messages: Message[], activity = 'idle'): Detail => ({ activity, messages });

describe('share', () => {
  it('returns the previous value when nothing changed', () => {
    const prev = detail([message('a'), message('b')]);
    expect(share(prev, detail([message('a'), message('b')]))).toBe(prev);
  });

  it('keeps every unchanged message when one message changed', () => {
    const prev = detail([message('a'), message('b'), message('c')]);
    const next = share(prev, detail([message('a'), message('b', 'Edited'), message('c')]));
    expect(next).not.toBe(prev);
    expect(next.messages[0]).toBe(prev.messages[0]);
    expect(next.messages[1]).not.toBe(prev.messages[1]);
    expect(next.messages[1]?.parts).toBe(prev.messages[1]?.parts);
    expect(next.messages[2]).toBe(prev.messages[2]);
    expect(next).toEqual(detail([message('a'), message('b', 'Edited'), message('c')]));
  });

  it('keeps unchanged messages when the list grows or shrinks', () => {
    const prev = detail([message('a'), message('b')]);
    const grown = share(prev, detail([message('a'), message('b'), message('c')]));
    expect(grown.messages[0]).toBe(prev.messages[0]);
    expect(grown.messages[1]).toBe(prev.messages[1]);
    expect(grown.messages).toHaveLength(3);
    const shrunk = share(prev, detail([message('a')]));
    expect(shrunk.messages).toEqual([message('a')]);
    expect(shrunk.messages[0]).toBe(prev.messages[0]);
  });

  it('compares own keys only, so an inherited member never reads as unchanged', () => {
    const prev: Json = { a: 1 };
    const next: Json = JSON.parse('{"__proto__":{}}');
    const shared = share(prev, next);
    expect(shared).not.toBe(prev);
    expect(Object.getOwnPropertyDescriptor(shared, '__proto__')?.value).toEqual({});
    expect(Object.getOwnPropertyDescriptor(shared, '__proto__')?.value).not.toBe(Object.prototype);
  });

  it('takes the new value when there is nothing to share with', () => {
    const next = detail([message('a')]);
    expect(share(undefined, next)).toBe(next);
    expect(share(detail([message('a')]), detail([message('a')], 'running')).activity).toBe(
      'running',
    );
  });
});

describe('cache', () => {
  afterEach(() => clearCache());

  it('keys answers per computer and clears one computer at a time', () => {
    const first = resourceKey('device-1', 'route-1', { type: 'flows' });
    const second = resourceKey('device-2', 'route-2', { type: 'flows' });
    expect(first).not.toBe(second);
    cacheWriter('device-1')(first, ['one'], 1);
    cacheWriter('device-2')(second, ['two'], 2);
    expect(readCache<string[]>(first)).toEqual({
      deviceId: 'device-1',
      data: ['one'],
      updatedAt: 1,
    });

    clearCache('device-1');
    expect(readCache(first)).toBeUndefined();
    expect(readCache<string[]>(second)?.data).toEqual(['two']);
  });

  it('drops the least recently written answer once full', () => {
    const key = (id: string) => resourceKey('device-1', 'route-1', { type: 'chat', id });
    const write = cacheWriter('device-1');
    for (let i = 0; i < CACHE_LIMIT; i++) write(key(`${i}`), i);
    write(key('0'), 0);
    write(key('new'), 'new');
    expect(readCache(key('0'))).toBeDefined();
    expect(readCache(key('1'))).toBeUndefined();
    expect(readCache(key('new'))?.data).toBe('new');
  });

  it('stores nothing for a request whose computer was cleared after it started', () => {
    const key = resourceKey('device-1', 'route-1', { type: 'flows' });
    const before = cacheWriter('device-1');
    const other = cacheWriter('device-2');
    clearCache('device-1');
    before(key, ['late']);
    expect(readCache(key)).toBeUndefined();
    other(resourceKey('device-2', 'route-2', { type: 'flows' }), ['kept']);
    expect(readCache(resourceKey('device-2', 'route-2', { type: 'flows' }))).toBeDefined();
    cacheWriter('device-1')(key, ['fresh']);
    expect(readCache<string[]>(key)?.data).toEqual(['fresh']);
  });

  it('treats an answer written in the future as not fresh', () => {
    const key = resourceKey('device-1', 'route-1', { type: 'flows' });
    cacheWriter('device-1')(key, [], 1_000);
    expect(freshSince(key, 3_000, 2_000)).toBe(1_000);
    expect(freshSince(key, 3_000, 5_000)).toBeUndefined();
    expect(freshSince(key, 3_000, 900)).toBeUndefined();
  });
});

describe('prefetch', () => {
  afterEach(() => clearCache());

  const deferred = () => {
    let resolve = (_: string[]) => {};
    const promise = new Promise<string[]>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  it('asks once and lets a screen share the answer still on its way', async () => {
    const key = resourceKey('device-1', 'route-1', { type: 'chats', limit: CHATS_PAGE });
    const answer = deferred();
    let asked = 0;
    const load = () => {
      asked++;
      return answer.promise;
    };
    prefetch(key, 'device-1', load);
    prefetch(key, 'device-1', load);
    expect(asked).toBe(1);
    const shared = prefetched<string[]>(key);
    expect(shared).toBe(answer.promise);
    answer.resolve(['chat']);
    expect(await shared).toEqual(['chat']);
    await answer.promise;
    await Promise.resolve();
    expect(readCache<string[]>(key)?.data).toEqual(['chat']);
    expect(prefetched(key)).toBeUndefined();
    prefetch(key, 'device-1', load);
    expect(asked).toBe(1);
  });

  it('drops a prefetch whose computer is forgotten before it lands', async () => {
    const key = resourceKey('device-1', 'route-1', { type: 'flows' });
    const answer = deferred();
    prefetch(key, 'device-1', () => answer.promise);
    clearCache('device-1');
    expect(prefetched(key)).toBeUndefined();
    answer.resolve(['flow']);
    await answer.promise;
    await Promise.resolve();
    expect(readCache(key)).toBeUndefined();
  });

  it('asks for the same first page of chats the Chats screen loads', () => {
    expect(FIRST_PAGES).toContainEqual({ type: 'chats', limit: CHATS_PAGE });
  });
});
