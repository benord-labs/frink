import { afterEach, describe, expect, it } from 'vitest';
import { __resetSubChatLocks, withSubChatLock } from './sub-chat-mutex';

afterEach(() => {
  __resetSubChatLocks();
});

describe('withSubChatLock', () => {
  it('serializes concurrent operations on the same sub-chat', async () => {
    const log: string[] = [];
    const slow = (label: string) => async () => {
      log.push(`enter:${label}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`exit:${label}`);
    };

    await Promise.all([
      withSubChatLock('s1', slow('a')),
      withSubChatLock('s1', slow('b')),
      withSubChatLock('s1', slow('c')),
    ]);

    // Each operation must fully complete (enter + exit) before the next begins.
    expect(log).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b', 'enter:c', 'exit:c']);
  });

  it('allows parallel operations on different sub-chats', async () => {
    const order: string[] = [];

    const slow = async () => {
      order.push('s1:enter');
      await new Promise((r) => setTimeout(r, 20));
      order.push('s1:exit');
    };
    const fast = async () => {
      order.push('s2:enter');
      order.push('s2:exit');
    };

    await Promise.all([withSubChatLock('s1', slow), withSubChatLock('s2', fast)]);

    // Different sub-chats must not block each other: s2 finishes before s1 exits.
    const s1ExitIdx = order.indexOf('s1:exit');
    const s2ExitIdx = order.indexOf('s2:exit');
    expect(s2ExitIdx).toBeLessThan(s1ExitIdx);
  });

  it('returns the value resolved by the inner function', async () => {
    const result = await withSubChatLock('s1', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors thrown by the inner function and frees the lock', async () => {
    await expect(
      withSubChatLock('s1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Lock must be released so the next caller can acquire it.
    const result = await withSubChatLock('s1', async () => 'ok');
    expect(result).toBe('ok');
  });
});
