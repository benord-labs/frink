import { afterEach, describe, expect, it } from 'vitest';
import { CACHE_LIMIT, clearCache, readCache, resourceKey, share, writeCache } from './cache';

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
    writeCache(first, 'device-1', ['one'], 1);
    writeCache(second, 'device-2', ['two'], 2);
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
    for (let i = 0; i < CACHE_LIMIT; i++) writeCache(key(`${i}`), 'device-1', i);
    writeCache(key('0'), 'device-1', 0);
    writeCache(key('new'), 'device-1', 'new');
    expect(readCache(key('0'))).toBeDefined();
    expect(readCache(key('1'))).toBeUndefined();
    expect(readCache(key('new'))?.data).toBe('new');
  });
});
