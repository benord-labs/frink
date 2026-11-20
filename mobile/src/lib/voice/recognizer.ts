import type {
  ExpoSpeechRecognitionNativeEventMap,
  ExpoSpeechRecognitionOptions,
} from 'expo-speech-recognition';
import type { RecognitionEvents, RecognitionSession, Recognizer } from './dictation';

type SpeechEvents = ExpoSpeechRecognitionNativeEventMap;

/** The parts of the native speech module used here. */
export type SpeechModule = {
  addListener<K extends keyof SpeechEvents>(
    name: K,
    listener: (event: SpeechEvents[K]) => void,
  ): { remove: () => void };
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  getStateAsync: () => Promise<string>;
  start: (options: ExpoSpeechRecognitionOptions) => void;
  stop: () => void;
  abort: () => void;
  supportsOnDeviceRecognition: () => boolean;
  setAudioSessionActiveIOS: (
    active: boolean,
    options: { notifyOthersOnDeactivation: boolean },
  ) => void;
};

/** Ends still owed this long after a recognition was let go mean asking whether it is really over. */
export const END_WAIT_MS = 1500;

/** The recognition this adapter treats as live. `started` turns true at its own native "start". */
type NativeSession = {
  events: RecognitionEvents;
  started: boolean;
  failed: boolean;
  stopped: boolean;
  /** An error that came while an earlier "end" was owed, given out once this one is known over. */
  heldError: string | null;
};

/** The phone's language, e.g. "en-GB", so words are heard the way the user speaks. */
export function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

/** Hands the audio session back so other apps' sound returns at full volume. */
function releaseAudio(module: SpeechModule): void {
  try {
    module.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
  } catch {
    // The session is already inactive; that is fine.
  }
}

function speechOptions(lang: string, onDevice: boolean): ExpoSpeechRecognitionOptions {
  return {
    lang,
    interimResults: true,
    continuous: true,
    requiresOnDeviceRecognition: onDevice,
    addsPunctuation: true,
    iosTaskHint: 'dictation',
    iosCategory: {
      category: 'playAndRecord',
      categoryOptions: ['defaultToSpeaker', 'allowBluetooth', 'allowBluetoothA2DP', 'allowAirPlay'],
      mode: 'measurement',
    },
  };
}

/** A recognizer over the native module, loaded on first use. Native events carry no session, so
 *  it counts the "end" events still owed by recognitions it let go, and pays those first. */
export class SpeechRecognizer implements Recognizer {
  private loaded: SpeechModule | null = null;
  private session: NativeSession | null = null;
  private owed = 0;
  private pending: RecognitionEvents | null = null;
  private wait: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly load: () => SpeechModule,
    private readonly lang = deviceLocale(),
  ) {}

  async requestPermission() {
    return (await this.module().requestPermissionsAsync()).granted;
  }

  /** The latest start wins: an earlier one still waiting is told it ended without starting. */
  start(events: RecognitionEvents): RecognitionSession {
    this.pending?.end();
    this.pending = events;
    const replaced = this.session?.events;
    this.letGo();
    replaced?.end();
    this.next();
    return { stop: () => this.stopFor(events), abort: () => this.abortFor(events) };
  }

  /** Starts the waiting recognition once nothing earlier still owes an "end". */
  private next(): void {
    if (this.session) return;
    if (this.owed > 0)
      return void (this.wait ??= setTimeout(() => void this.settle(), END_WAIT_MS));
    clearTimeout(this.wait);
    this.wait = undefined;
    if (this.pending) this.launch(this.pending);
  }

  private launch(events: RecognitionEvents): void {
    const module = this.module();
    this.pending = null;
    this.session = { events, started: false, failed: false, stopped: false, heldError: null };
    try {
      module.start(speechOptions(this.lang, module.supportsOnDeviceRecognition()));
    } catch {
      this.session = null;
      events.error('start-failed');
    }
  }

  private stopFor(events: RecognitionEvents): void {
    if (this.pending === events) return void (this.pending = null);
    const session = this.session;
    if (session?.events !== events || session.stopped || session.failed) return;
    session.stopped = true;
    this.module().stop();
  }

  private abortFor(events: RecognitionEvents): void {
    if (this.pending === events) return void (this.pending = null);
    if (this.session?.events !== events) return;
    this.letGo();
    this.next();
  }

  /** Its "end" is now owed. One already on its way after an error or a stop is not asked for again. */
  private letGo(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.owed++;
    if (!session.failed && !session.stopped) this.module().abort();
  }

  /** An owed "end" is paid first, so it can never end a live recording or take its audio. */
  private onEnd(): void {
    const session = this.session;
    if (this.owed > 0) {
      this.owed--;
      if (session?.started) void this.endIfOver(session);
    }
    // Before its own start and without an error, an "end" is the start resetting an earlier one.
    else if (session?.started || session?.failed) this.session = null;
    if (!this.session) this.close(session);
  }

  /** The paid "end" may have been this recognition's own, if an owed one was lost: ask the module. */
  private async endIfOver(session: NativeSession): Promise<void> {
    const state = await this.module()
      .getStateAsync()
      .catch(() => 'unknown');
    if (state !== 'inactive' || this.session !== session) return;
    // The paid "end" was this one's own, so the earlier one is owed again.
    this.owed++;
    this.session = null;
    if (session.heldError) session.events.error(session.heldError);
    this.close(session);
  }

  private close(session: NativeSession | null): void {
    releaseAudio(this.module());
    session?.events.end();
    this.next();
  }

  private onStart(): void {
    const session = this.session;
    if (!session || session.started) return;
    session.started = true;
    session.events.started();
  }

  /** While an earlier recognition still owes an "end", an error may be its own, so it is held. */
  private onError(code: string): void {
    const session = this.session;
    if (!session) return;
    if (this.owed > 0) return void (session.heldError = code);
    session.failed = true;
    session.events.error(code);
  }

  /** Owed "end" events are overdue: make sure the microphone is off, then start or refuse. */
  private async settle(): Promise<void> {
    this.wait = undefined;
    if (this.session || this.owed === 0) return;
    const state = await this.module()
      .getStateAsync()
      .catch(() => 'unknown');
    if (this.session || this.owed === 0) return;
    if (state === 'inactive') {
      if (this.pending) this.launch(this.pending);
      return;
    }
    // Every abort sends exactly one "end", so this one is owed as well.
    this.owed++;
    this.module().abort();
    const refused = this.pending;
    this.pending = null;
    refused?.error('busy');
  }

  private module(): SpeechModule {
    if (this.loaded) return this.loaded;
    const module = this.load();
    module.addListener('start', () => this.onStart());
    module.addListener('result', (event) => {
      if (this.session?.started)
        this.session.events.result(event.results[0]?.transcript ?? '', event.isFinal);
    });
    module.addListener('error', (event) => this.onError(event.error));
    module.addListener('end', () => this.onEnd());
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
