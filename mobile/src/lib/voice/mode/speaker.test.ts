import { expect, it, vi } from 'vitest';
import type { SpeechOptions, Voice } from 'expo-speech';
import { NativeSpeaker, bestVoice, type SpeechPackage } from './speaker';

function voice(identifier: string, language: string, enhanced: boolean): Voice {
  // SAFETY: the package's enum values are these strings; importing the enum would load the native module.
  const quality = (enhanced ? 'Enhanced' : 'Default') as Voice['quality'];
  return { identifier, name: identifier, language, quality };
}

type FakeSpeech = SpeechPackage & { spoken: Array<{ text: string; options: SpeechOptions }> };

function fakeSpeech(voices: Voice[]): FakeSpeech {
  const spoken: FakeSpeech['spoken'] = [];
  return {
    spoken,
    speak: (text, options = {}) => void spoken.push({ text, options }),
    stop: vi.fn(() => Promise.resolve()),
    getAvailableVoicesAsync: () => Promise.resolve(voices),
  };
}

it('picks an enhanced voice, the exact locale first, then the same language', () => {
  const voices = [
    voice('us-basic', 'en-US', false),
    voice('us-good', 'en-US', true),
    voice('gb-good', 'en-GB', true),
  ];
  expect(bestVoice(voices, 'en-GB')).toBe('gb-good');
  expect(bestVoice(voices, 'en-AU')).toBe('us-good');
  expect(bestVoice(voices, 'fr-FR')).toBeUndefined();
});

it('loads speech on first use, speaks in its own audio session and reports how a line ended', async () => {
  const speech = fakeSpeech([voice('gb-good', 'en-GB', true)]);
  const load = vi.fn(() => speech);
  const speaker = new NativeSpeaker(load, 'en-GB');
  expect(load).not.toHaveBeenCalled();
  const done = vi.fn();
  speaker.say('Hello.', done);
  expect(speech.spoken[0]).toMatchObject({
    text: 'Hello.',
    options: { language: 'en-GB', useApplicationAudioSession: false },
  });
  speech.spoken[0].options.onDone?.();
  speech.spoken[0].options.onStopped?.();
  expect(done.mock.calls).toEqual([[true], [false]]);
  await Promise.resolve();
  speaker.say('Again.', done);
  expect(speech.spoken[1].options.voice).toBe('gb-good');
  speaker.hush();
  expect(speech.stop).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
});

it('tells a line as not said when speech throws, and hushes even if it never loaded', () => {
  const speech = fakeSpeech([]);
  const throwing = new NativeSpeaker(() => ({
    ...speech,
    speak: () => {
      throw new Error('native');
    },
  }));
  const done = vi.fn();
  throwing.say('Hello.', done);
  expect(done).toHaveBeenCalledWith(false);
  const missing = new NativeSpeaker(() => {
    throw new Error('no module');
  });
  missing.say('Hello.', done);
  expect(done).toHaveBeenCalledTimes(2);
  expect(() => missing.hush()).not.toThrow();
});
