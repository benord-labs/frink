import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExpoSpeechRecognitionNativeEventMap } from 'expo-speech-recognition';
import { Dictation, NOTICES, type DictationState } from './dictation';
import { END_WAIT_MS, SpeechRecognizer, type SpeechModule } from './recognizer';

type EventName = keyof ExpoSpeechRecognitionNativeEventMap;
type Listener<K extends EventName> = (event: ExpoSpeechRecognitionNativeEventMap[K]) => void;

function fakeModule() {
  const listeners = new Map<EventName, Set<Listener<EventName>>>();
  const module = {
    addListener<K extends EventName>(name: K, listener: Listener<K>) {
      const set = listeners.get(name) ?? new Set();
      // SAFETY: each set only ever holds listeners for its own event name.
      const stored = listener as Listener<EventName>;
      set.add(stored);
      listeners.set(name, set);
      return { remove: () => void set.delete(stored) };
    },
    requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
    getStateAsync: vi.fn(async () => 'inactive'),
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    supportsOnDeviceRecognition: () => true,
    setAudioSessionActiveIOS: vi.fn(),
  };
  function emit<K extends EventName>(name: K, event: ExpoSpeechRecognitionNativeEventMap[K]) {
    listeners.get(name)?.forEach((listener) => listener(event));
  }
  const typed: SpeechModule = module;
  return {
    module: typed,
    raw: module,
    emit,
    count: (name: EventName) => listeners.get(name)?.size ?? 0,
  };
}

function setup() {
  const fake = fakeModule();
  return { ...fake, recognizer: new SpeechRecognizer(() => fake.module, 'en-GB') };
}

function dictationOver(recognizer: SpeechRecognizer) {
  const states: DictationState[] = [];
  const dictation = new Dictation({
    recognizer,
    read: () => '',
    write: () => {},
    onChange: (state) => states.push(state),
  });
  return { dictation, states };
}

const events = () => ({ started: vi.fn(), result: vi.fn(), error: vi.fn(), end: vi.fn() });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it('loads where the speech package cannot, because it refers only to the package types', async () => {
  vi.useRealTimers();
  await expect(import('expo-speech-recognition')).rejects.toThrow();
  await expect(import('./recognizer')).resolves.toHaveProperty('nativeRecognizer');
});

it('starts continuous on-device dictation in the phone language with live partial results', () => {
  const { module, raw } = fakeModule();
  new SpeechRecognizer(() => module).start(events());
  expect(raw.start).toHaveBeenCalledWith(
    expect.objectContaining({
      lang: Intl.DateTimeFormat().resolvedOptions().locale,
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: true,
      iosTaskHint: 'dictation',
    }),
  );
});

it('passes on the start, the best transcript, errors and the end of its recognition', () => {
  const { recognizer, emit } = setup();
  const heard = events();
  recognizer.start(heard);
  emit('start', null);
  emit('result', { isFinal: false, results: [] });
  emit('error', { error: 'network', message: 'offline' });
  emit('end', null);
  emit('end', null);
  expect(heard.started).toHaveBeenCalledTimes(1);
  expect(heard.result).toHaveBeenCalledWith('', false);
  expect(heard.error).toHaveBeenCalledWith('network');
  expect(heard.end).toHaveBeenCalledTimes(1);
});

it('starts a new recognition only once the aborted one has ended', () => {
  const { recognizer, raw, emit } = setup();
  const first = events();
  const second = events();
  recognizer.start(first).abort();
  recognizer.start(second);
  expect(raw.abort).toHaveBeenCalledTimes(1);
  expect(raw.start).toHaveBeenCalledTimes(1);
  emit('error', { error: 'aborted', message: 'Speech recognition aborted.' });
  emit('end', null);
  expect(raw.start).toHaveBeenCalledTimes(2);
  emit('start', null);
  expect(second.started).toHaveBeenCalled();
  expect(second.error).not.toHaveBeenCalled();
  expect(second.end).not.toHaveBeenCalled();
  expect(first.end).not.toHaveBeenCalled();
});

it('keeps the audio session while a recognition is recording and hands it back at its end', () => {
  const { recognizer, raw, emit } = setup();
  recognizer.start(events()).abort();
  recognizer.start(events());
  expect(raw.setAudioSessionActiveIOS).not.toHaveBeenCalled();
  emit('end', null);
  expect(raw.setAudioSessionActiveIOS).toHaveBeenCalledTimes(1);
  expect(raw.setAudioSessionActiveIOS.mock.invocationCallOrder[0]).toBeLessThan(
    raw.start.mock.invocationCallOrder[1],
  );
  emit('start', null);
  emit('result', { isFinal: false, results: [] });
  expect(raw.setAudioSessionActiveIOS).toHaveBeenCalledTimes(1);
  raw.setAudioSessionActiveIOS.mockImplementation(() => {
    throw new Error('Session is already inactive');
  });
  expect(() => emit('end', null)).not.toThrow();
});

it('keeps only the latest start while one is ending, and the replaced caller hears an end', () => {
  const { recognizer, raw, emit } = setup();
  const live = events();
  const replaced = events();
  const latest = events();
  recognizer.start(live);
  recognizer.start(replaced);
  recognizer.start(latest);
  expect(live.end).toHaveBeenCalledTimes(1);
  expect(replaced.end).toHaveBeenCalledTimes(1);
  expect(raw.abort).toHaveBeenCalledTimes(1);
  emit('end', null);
  emit('start', null);
  expect(raw.start).toHaveBeenCalledTimes(2);
  expect(latest.started).toHaveBeenCalled();
  expect(replaced.started).not.toHaveBeenCalled();
});

it('drops a waiting start that its caller gave up on', () => {
  const { recognizer, raw, emit } = setup();
  recognizer.start(events()).abort();
  recognizer.start(events()).stop();
  emit('end', null);
  expect(raw.start).toHaveBeenCalledTimes(1);
});

/** Lets A go with its "end" still to come, then starts B through the bounded wait. */
async function fallbackLaunch() {
  const fake = setup();
  const live = events();
  fake.recognizer.start(events()).abort();
  fake.recognizer.start(live);
  await vi.advanceTimersByTimeAsync(END_WAIT_MS);
  return { ...fake, live };
}

it('starts after the wait once the earlier recognition is over, and its late end changes nothing', async () => {
  const { raw, emit, live } = await fallbackLaunch();
  expect(raw.getStateAsync).toHaveBeenCalled();
  expect(raw.start).toHaveBeenCalledTimes(2);
  emit('end', null);
  emit('start', null);
  emit('result', { isFinal: false, results: [] });
  expect(live.end).not.toHaveBeenCalled();
  expect(live.result).toHaveBeenCalledTimes(1);
  expect(raw.setAudioSessionActiveIOS).not.toHaveBeenCalled();
  emit('end', null);
  expect(live.end).toHaveBeenCalledTimes(1);
  expect(raw.setAudioSessionActiveIOS).toHaveBeenCalledTimes(1);
});

it('keeps a late result, error and end of the earlier recognition away from the one started after the wait', async () => {
  const { emit, live } = await fallbackLaunch();
  emit('result', { isFinal: true, results: [] });
  emit('error', { error: 'aborted', message: 'Speech recognition aborted.' });
  emit('end', null);
  emit('start', null);
  expect(live.result).not.toHaveBeenCalled();
  expect(live.error).not.toHaveBeenCalled();
  expect(live.end).not.toHaveBeenCalled();
  expect(live.started).toHaveBeenCalledTimes(1);
});

it('keeps recording when the late end and error of the earlier one come after the new one started', async () => {
  const { raw, emit, live } = await fallbackLaunch();
  raw.getStateAsync.mockResolvedValue('recognizing');
  emit('start', null);
  emit('error', { error: 'aborted', message: 'Speech recognition aborted.' });
  emit('end', null);
  await vi.advanceTimersByTimeAsync(0);
  expect(live.error).not.toHaveBeenCalled();
  expect(live.end).not.toHaveBeenCalled();
  expect(raw.setAudioSessionActiveIOS).not.toHaveBeenCalled();
  emit('end', null);
  expect(live.end).toHaveBeenCalledTimes(1);
});

it('refuses a start when the earlier recognition is still running, and owes the extra abort its end', async () => {
  const { recognizer, raw, emit } = setup();
  raw.getStateAsync.mockResolvedValueOnce('recognizing');
  const refused = events();
  const later = events();
  recognizer.start(events()).abort();
  recognizer.start(refused);
  await vi.advanceTimersByTimeAsync(END_WAIT_MS);
  expect(refused.error).toHaveBeenCalledWith('busy');
  expect(raw.abort).toHaveBeenCalledTimes(2);
  recognizer.start(later);
  emit('end', null);
  expect(raw.start).toHaveBeenCalledTimes(1);
  emit('end', null);
  expect(raw.start).toHaveBeenCalledTimes(2);
  emit('start', null);
  expect(later.started).toHaveBeenCalled();
  expect(later.end).not.toHaveBeenCalled();
});

it('never escalates a stop, and a second end around the next start cannot end it', () => {
  const { recognizer, raw, emit } = setup();
  const next = events();
  const first = recognizer.start(events());
  emit('start', null);
  first.stop();
  first.stop();
  first.abort();
  expect(raw.stop).toHaveBeenCalledTimes(1);
  expect(raw.abort).not.toHaveBeenCalled();
  recognizer.start(next);
  emit('end', null);
  expect(raw.start).toHaveBeenCalledTimes(2);
  emit('end', null);
  emit('start', null);
  expect(next.end).not.toHaveBeenCalled();
  expect(next.started).toHaveBeenCalled();
  expect(raw.setAudioSessionActiveIOS).toHaveBeenCalledTimes(1);
});

it('checks that a stopped recognition whose end never came is off, and aborts it if not', async () => {
  const { recognizer, raw } = setup();
  raw.getStateAsync.mockResolvedValueOnce('recognizing');
  const first = recognizer.start(events());
  first.stop();
  first.abort();
  await vi.advanceTimersByTimeAsync(END_WAIT_MS);
  expect(raw.abort).toHaveBeenCalledTimes(1);
});

it('ends the next recognition at its own end when an owed end was lost, once it no longer records', async () => {
  const { recognizer, raw, emit } = setup();
  const first = recognizer.start(events());
  emit('start', null);
  first.stop();
  first.abort();
  const next = events();
  recognizer.start(next);
  await vi.advanceTimersByTimeAsync(END_WAIT_MS);
  expect(raw.start).toHaveBeenCalledTimes(2);
  emit('start', null);
  emit('end', null);
  expect(next.end).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(next.end).toHaveBeenCalledTimes(1);
  expect(raw.setAudioSessionActiveIOS).toHaveBeenCalledTimes(1);
});

it('still owes the earlier late end after the next recognition ended, so it cannot end a later one', async () => {
  const { recognizer, raw, emit, live } = await fallbackLaunch();
  emit('start', null);
  emit('error', { error: 'not-allowed', message: 'denied' });
  emit('end', null);
  await vi.advanceTimersByTimeAsync(0);
  expect(live.error).toHaveBeenCalledWith('not-allowed');
  const later = events();
  recognizer.start(later);
  expect(raw.start).toHaveBeenCalledTimes(2);
  emit('end', null);
  expect(raw.start).toHaveBeenCalledTimes(3);
  emit('start', null);
  expect(later.end).not.toHaveBeenCalled();
  expect(later.started).toHaveBeenCalled();
});

it('drops the wait once every owed end has come, so a later one gets its own full wait', async () => {
  const { recognizer, raw, emit } = setup();
  recognizer.start(events()).abort();
  emit('end', null);
  await vi.advanceTimersByTimeAsync(END_WAIT_MS - 500);
  recognizer.start(events()).abort();
  recognizer.start(events());
  await vi.advanceTimersByTimeAsync(600);
  expect(raw.getStateAsync).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(END_WAIT_MS);
  expect(raw.getStateAsync).toHaveBeenCalledTimes(1);
});

it('never asks a recognition that failed by itself to abort', () => {
  const { recognizer, raw, emit } = setup();
  const failed = recognizer.start(events());
  emit('error', { error: 'audio-capture', message: 'no input' });
  failed.abort();
  expect(raw.abort).not.toHaveBeenCalled();
});

it('leaves one live recognition and nothing owed after rapid starts and aborts with late ends', async () => {
  const { recognizer, raw, emit } = setup();
  const [first, dropped, third, last] = Array.from({ length: 4 }, events);
  recognizer.start(first).abort();
  recognizer.start(dropped).abort();
  const thirdSession = recognizer.start(third);
  await vi.advanceTimersByTimeAsync(END_WAIT_MS);
  thirdSession.abort();
  recognizer.start(last);
  emit('error', { error: 'aborted', message: 'Speech recognition aborted.' });
  emit('end', null);
  expect(raw.start).toHaveBeenCalledTimes(2);
  emit('end', null);
  expect(raw.start).toHaveBeenCalledTimes(3);
  expect(raw.abort).toHaveBeenCalledTimes(2);
  emit('start', null);
  emit('end', null);
  expect([first, dropped, third].some((caller) => caller.started.mock.calls.length)).toBe(false);
  expect(last.started).toHaveBeenCalledTimes(1);
  expect(last.end).toHaveBeenCalledTimes(1);
  recognizer.start(events());
  expect(raw.start).toHaveBeenCalledTimes(4);
});

it('reports a native start that throws and stays ready to start again', () => {
  const { recognizer, raw } = setup();
  raw.start.mockImplementationOnce(() => {
    throw new Error('Recognizer unavailable');
  });
  const failed = events();
  recognizer.start(failed);
  expect(failed.error).toHaveBeenCalledWith('start-failed');
  recognizer.start(events());
  expect(raw.start).toHaveBeenCalledTimes(2);
});

it('reports whether the user allowed dictation', async () => {
  const { recognizer, raw } = setup();
  await expect(recognizer.requestPermission()).resolves.toBe(true);
  raw.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });
  await expect(recognizer.requestPermission()).resolves.toBe(false);
});

it('loads the native module once, on first use, and listens to it once for the whole app', () => {
  const { module, count } = fakeModule();
  const load = vi.fn(() => module);
  const recognizer = new SpeechRecognizer(load, 'en-GB');
  expect(load).not.toHaveBeenCalled();
  recognizer.start(events()).abort();
  recognizer.start(events());
  expect(load).toHaveBeenCalledTimes(1);
  expect(count('end')).toBe(1);
});

it('leaves one recognition and a matching button after rapid taps on the microphone', async () => {
  const { recognizer, raw, emit } = setup();
  const { dictation, states } = dictationOver(recognizer);
  for (let tap = 0; tap < 5; tap++) {
    dictation.toggle();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(raw.start).toHaveBeenCalledTimes(1);
  expect(raw.abort).toHaveBeenCalledTimes(1);
  expect(dictation.phase).toBe('starting');
  emit('end', null);
  emit('start', null);
  expect(raw.start).toHaveBeenCalledTimes(2);
  expect(dictation.phase).toBe('listening');
  expect(states.at(-1)).toEqual({ phase: 'listening', notice: null });
});

it('tells the user to wait when it cannot confirm the microphone is free after the wait', async () => {
  const { recognizer, raw } = setup();
  raw.getStateAsync.mockRejectedValue(new Error('Module unavailable'));
  const { dictation, states } = dictationOver(recognizer);
  recognizer.start(events()).abort();
  await dictation.start();
  await vi.advanceTimersByTimeAsync(END_WAIT_MS);
  expect(states.at(-1)).toEqual({ phase: 'idle', notice: NOTICES.busy });
});
