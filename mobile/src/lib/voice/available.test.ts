import { expect, it, vi } from 'vitest';
import { DICTATION_MODULES, VOICE_MODE_MODULES, voiceAvailable } from './available';

type Found = { name: string };
const present = (name: string): Found | null => ({ name });
const only =
  (...names: string[]) =>
  (name: string): Found | null =>
    names.includes(name) ? { name } : null;

it('is off when the installed build lacks the native modules', () => {
  const find = vi.fn((_name: string): Found | null => null);
  expect(voiceAvailable(DICTATION_MODULES, 'ios', find)).toBe(false);
  expect(find).toHaveBeenCalledWith(DICTATION_MODULES[0]);
});

it('is off when only some other module is present', () => {
  expect(voiceAvailable(DICTATION_MODULES, 'ios', only('ExpoSpeech'))).toBe(false);
});

it('is on when every module is present', () => {
  expect(voiceAvailable(DICTATION_MODULES, 'ios', present)).toBe(true);
  expect(voiceAvailable(VOICE_MODE_MODULES, 'ios', present)).toBe(true);
});

it('dictation needs only recognition; voice mode also needs speech output and keep-awake', () => {
  const recognitionOnly = only('ExpoSpeechRecognition');
  expect(voiceAvailable(DICTATION_MODULES, 'ios', recognitionOnly)).toBe(true);
  expect(voiceAvailable(VOICE_MODE_MODULES, 'ios', recognitionOnly)).toBe(false);
  expect(
    voiceAvailable(VOICE_MODE_MODULES, 'ios', only('ExpoSpeechRecognition', 'ExpoSpeech')),
  ).toBe(false);
  expect(
    voiceAvailable(VOICE_MODE_MODULES, 'ios', only('ExpoSpeechRecognition', 'ExpoKeepAwake')),
  ).toBe(false);
});

it('is off on web without looking anything up', () => {
  const find = vi.fn(present);
  expect(voiceAvailable(VOICE_MODE_MODULES, 'web', find)).toBe(false);
  expect(find).not.toHaveBeenCalled();
});
