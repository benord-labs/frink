import type {
  ExpoSpeechRecognitionNativeEventMap,
  ExpoSpeechRecognitionOptions,
} from 'expo-speech-recognition';
import type { RecognitionEvents, Recognizer } from './dictation';

type SpeechEvents = ExpoSpeechRecognitionNativeEventMap;

/** The parts of the native speech module used here. */
export type SpeechModule = {
  addListener<K extends keyof SpeechEvents>(
    name: K,
    listener: (event: SpeechEvents[K]) => void,
  ): { remove: () => void };
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  start: (options: ExpoSpeechRecognitionOptions) => void;
  stop: () => void;
  abort: () => void;
  supportsOnDeviceRecognition: () => boolean;
  setAudioSessionActiveIOS: (
    active: boolean,
    options: { notifyOthersOnDeactivation: boolean },
  ) => void;
};

/** The phone's language, e.g. "en-GB", so words are heard the way the user speaks. */
function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

/** Hands the audio session back so other apps' sound returns at full volume. */
function releaseAudio(module: SpeechModule): void {
  try {
    module.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
  } catch {
    // The session is already inactive or another recording is still using it; both are fine.
  }
}

/** A recognizer over the native module, loaded on first use. Every recognition ends with an "end"
 *  event, including an aborted one, so the audio session is released there whatever stopped it. */
export class SpeechRecognizer implements Recognizer {
  private loaded: SpeechModule | null = null;

  constructor(
    private readonly load: () => SpeechModule,
    private readonly lang = deviceLocale(),
  ) {}

  async requestPermission() {
    return (await this.module().requestPermissionsAsync()).granted;
  }

  listen(events: RecognitionEvents) {
    const module = this.module();
    const subscriptions = [
      module.addListener('result', (event) =>
        events.result(event.results[0]?.transcript ?? '', event.isFinal),
      ),
      module.addListener('error', (event) => events.error(event.error)),
      module.addListener('end', () => events.end()),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }

  start() {
    const module = this.module();
    module.start({
      lang: this.lang,
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: module.supportsOnDeviceRecognition(),
      addsPunctuation: true,
      iosTaskHint: 'dictation',
      iosCategory: {
        category: 'playAndRecord',
        categoryOptions: [
          'defaultToSpeaker',
          'allowBluetooth',
          'allowBluetoothA2DP',
          'allowAirPlay',
        ],
        mode: 'measurement',
      },
    });
  }

  stop() {
    this.module().stop();
  }

  abort() {
    this.module().abort();
  }

  private module(): SpeechModule {
    if (this.loaded) return this.loaded;
    const module = this.load();
    module.addListener('end', () => releaseAudio(module));
    this.loaded = module;
    return module;
  }
}

/** Loads the speech package. Use only once voice is known to be available: the package throws on
 *  import when the installed build lacks its native module. */
function loadSpeech(): SpeechModule {
  // SAFETY: a plain require keeps the package out of the app's start-up; its types are the package's own.
  return (require('expo-speech-recognition') as typeof import('expo-speech-recognition'))
    .ExpoSpeechRecognitionModule;
}

export const nativeRecognizer = new SpeechRecognizer(loadSpeech);
