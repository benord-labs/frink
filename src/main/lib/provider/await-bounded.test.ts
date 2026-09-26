import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { awaitBounded } from './await-bounded';

describe('awaitBounded', () => {
  it('resolves false when the work settles before the deadline', async () => {
    expect(await awaitBounded(delay(5), 1_000)).toBe(false);
  });

  it('resolves true when the deadline elapses first — the work keeps running', async () => {
    let finished = false;
    const work = delay(60).then(() => {
      finished = true;
    });
    expect(await awaitBounded(work, 10)).toBe(true);
    expect(finished).toBe(false); // we stopped WAITING, not the work
    await work;
    expect(finished).toBe(true); // ...and it completed in the background
  });

  it('propagates a rejection that happens before the deadline', async () => {
    await expect(awaitBounded(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
  });

  it('suppresses a rejection that happens after the deadline (no unhandled rejection)', async () => {
    const work = delay(50).then(() => {
      throw new Error('late boom');
    });
    expect(await awaitBounded(work, 10)).toBe(true);
    await delay(80); // let the late rejection fire — the suppressor must absorb it
  });
});
