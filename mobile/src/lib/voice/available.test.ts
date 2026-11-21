import { expect, it, vi } from 'vitest';
import { VOICE_MODULES, voiceAvailable } from './available';

type Found = { name: string };
const present = (name: string): Found | null => ({ name });

it('is off when the installed build lacks the native modules', () => {
  const find = vi.fn((_name: string): Found | null => null);
  expect(voiceAvailable('ios', find)).toBe(false);
  expect(find).toHaveBeenCalledWith(VOICE_MODULES[0]);
});

it('is off when only some other module is present', () => {
  expect(voiceAvailable('ios', (name) => (name === 'ExpoSpeech' ? present(name) : null))).toBe(
    false,
  );
});

it('is on when every module is present', () => {
  expect(voiceAvailable('ios', present)).toBe(true);
});

it('is off on web without looking anything up', () => {
  const find = vi.fn(present);
  expect(voiceAvailable('web', find)).toBe(false);
  expect(find).not.toHaveBeenCalled();
});
