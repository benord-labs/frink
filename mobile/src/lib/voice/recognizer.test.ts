import { expect, it, vi } from 'vitest';
import type { ExpoSpeechRecognitionNativeEventMap } from 'expo-speech-recognition';
import { SpeechRecognizer, type SpeechModule } from './recognizer';

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

it('loads where the speech package cannot, because it refers only to the package types', async () => {
  await expect(import('expo-speech-recognition')).rejects.toThrow();
  await expect(import('./recognizer')).resolves.toHaveProperty('nativeRecognizer');
});

it('starts continuous on-device dictation in the phone language with live partial results', () => {
  const { module, raw } = fakeModule();
  new SpeechRecognizer(() => module).start();
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

it('passes on the best transcript, errors and the end, until unsubscribed', () => {
  const { module, emit } = fakeModule();
  const events = { result: vi.fn(), error: vi.fn(), end: vi.fn() };
  const unlisten = new SpeechRecognizer(() => module, 'en-GB').listen(events);
  emit('result', { isFinal: false, results: [] });
  emit('error', { error: 'network', message: 'offline' });
  emit('end', null);
  expect(events.result).toHaveBeenCalledWith('', false);
  expect(events.error).toHaveBeenCalledWith('network');
  expect(events.end).toHaveBeenCalledTimes(1);
  unlisten();
  emit('end', null);
  expect(events.end).toHaveBeenCalledTimes(1);
});

it('releases the audio session whenever a recognition ends, even with nobody listening', () => {
  const { module, raw, emit } = fakeModule();
  const recognizer = new SpeechRecognizer(() => module, 'en-GB');
  recognizer.abort();
  emit('end', null);
  expect(raw.abort).toHaveBeenCalled();
  expect(raw.setAudioSessionActiveIOS).toHaveBeenCalledWith(false, {
    notifyOthersOnDeactivation: true,
  });
  raw.setAudioSessionActiveIOS.mockImplementation(() => {
    throw new Error('Session is busy');
  });
  expect(() => emit('end', null)).not.toThrow();
});

it('reports whether the user allowed dictation', async () => {
  const { module, raw } = fakeModule();
  const recognizer = new SpeechRecognizer(() => module, 'en-GB');
  await expect(recognizer.requestPermission()).resolves.toBe(true);
  raw.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });
  await expect(recognizer.requestPermission()).resolves.toBe(false);
  recognizer.stop();
  expect(raw.stop).toHaveBeenCalled();
});

it('loads the native module once, on first use, and adds one audio release for the whole app', () => {
  const { module, count } = fakeModule();
  const load = vi.fn(() => module);
  const recognizer = new SpeechRecognizer(load, 'en-GB');
  expect(load).not.toHaveBeenCalled();
  recognizer.start();
  recognizer.abort();
  recognizer.listen({ result: vi.fn(), error: vi.fn(), end: vi.fn() })();
  expect(load).toHaveBeenCalledTimes(1);
  expect(count('end')).toBe(1);
});
