import { expect, it, vi } from 'vitest';
import { switchAwake, type KeepAwake } from './keep-awake';

const settled = () => new Promise((done) => setTimeout(done, 0));

function awake(change: Partial<KeepAwake> = {}): KeepAwake {
  return {
    activateKeepAwakeAsync: vi.fn(() => Promise.resolve()),
    deactivateKeepAwake: vi.fn(() => Promise.resolve()),
    ...change,
  };
}

it('turns the screen on and off under the tag, in call order', async () => {
  const calls: string[] = [];
  const fake = awake({
    activateKeepAwakeAsync: (tag) => void calls.push(`on:${tag}`),
    deactivateKeepAwake: (tag) => void calls.push(`off:${tag}`),
  });
  switchAwake(true, 'voice', () => fake);
  switchAwake(false, 'voice', () => fake);
  await settled();
  expect(calls).toEqual(['on:voice', 'off:voice']);
});

it('lets go of a switch that returns nothing, rejects or throws, and a package that fails to load', async () => {
  const fail = () => {
    throw new Error('missing');
  };
  switchAwake(false, 'voice', () => awake({ deactivateKeepAwake: () => undefined }));
  switchAwake(true, 'voice', () =>
    awake({ activateKeepAwakeAsync: () => Promise.reject(new Error('busy')) }),
  );
  switchAwake(false, 'voice', () => awake({ deactivateKeepAwake: fail }));
  switchAwake(true, 'voice', fail);
  await expect(settled()).resolves.toBeUndefined();
});
