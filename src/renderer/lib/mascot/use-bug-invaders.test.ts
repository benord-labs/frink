// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseHiScore, saveHiScore } from './use-bug-invaders';

describe('saveHiScore', () => {
  // happy-dom has no Web Locks; Electron does. One exclusive lock at a time is all the save needs.
  beforeAll(() => {
    let queue = Promise.resolve();
    const request = (_name: string, run: () => number) => {
      const next = queue.then(run);
      queue = next.then(() => undefined);
      return next;
    };
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  });
  beforeEach(() => localStorage.clear());

  it('never lowers a hi-score another window already raised', async () => {
    expect(await saveHiScore(10_000)).toBe(10_000);
    expect(await saveHiScore(5000)).toBe(10_000);
    expect(localStorage.getItem('frink:bug-invaders-hi')).toBe('10000');
  });

  it('records a new best', async () => {
    await saveHiScore(800);
    expect(await saveHiScore(1200)).toBe(1200);
  });
});

describe('parseHiScore', () => {
  it('reads a stored score and rejects anything that is not a sane one', () => {
    expect(parseHiScore('1200')).toBe(1200);
    for (const raw of [null, '', 'abc', 'Infinity', '-5', '12.5', '1e400']) {
      expect(parseHiScore(raw)).toBe(0);
    }
  });
});
