import { beforeEach, expect, it, vi } from 'vitest';
const keychain = vi.hoisted(() => ({ values: new Map<string, string>(), locked: false }));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => {
    if (keychain.locked) throw new Error('keychain locked');
    return keychain.values.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => void keychain.values.set(key, value),
}));
import { forgetTurnedOn, markTurnedOn, turnOnByDefault } from './default-on';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  keychain.values.clear();
  keychain.locked = false;
  platform.OS = 'ios';
});

it('turns alerts on once per computer, so switching back never re-enables them', async () => {
  expect(await turnOnByDefault('a')).toBe(true);
  markTurnedOn('a');
  await settle();
  expect(await turnOnByDefault('a')).toBe(false);
  expect(await turnOnByDefault('b')).toBe(true);
  markTurnedOn('b');
  await settle();
  expect(await turnOnByDefault('a')).toBe(false);
  expect(await turnOnByDefault('b')).toBe(false);
});

it('a forgotten computer turns its alerts on again when paired anew', async () => {
  markTurnedOn('a');
  await settle();
  forgetTurnedOn('a');
  await settle();
  expect(await turnOnByDefault('a')).toBe(true);
});

it('never asks from a browser preview or when the choice can’t be read', async () => {
  keychain.locked = true;
  expect(await turnOnByDefault('a')).toBe(false);
  keychain.locked = false;
  platform.OS = 'web';
  expect(await turnOnByDefault('a')).toBe(false);
});

it('two computers turned on at once both stick', async () => {
  markTurnedOn('a');
  markTurnedOn('b');
  await settle();
  await settle();
  expect(await turnOnByDefault('a')).toBe(false);
  expect(await turnOnByDefault('b')).toBe(false);
});

it('an unreadable stored value counts as none and is repaired by the next change', async () => {
  keychain.values.set('frink.mobile.alerts-on.v2', '[');
  expect(await turnOnByDefault('a')).toBe(true);
  markTurnedOn('a');
  await settle();
  expect(await turnOnByDefault('a')).toBe(false);
});

it('a choice still being saved is what a quick switch back reads', async () => {
  markTurnedOn('a');
  expect(await turnOnByDefault('a')).toBe(false);
});
