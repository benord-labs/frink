import type { Voice } from 'expo-speech';
import { deviceLocale } from '../recognizer';

/** Reads lines aloud one at a time. `done` hears whether the line was said to its end. */
export type Speaker = {
  say: (text: string, done: (finished: boolean) => void) => void;
  hush: () => void;
};

/** The parts of the speech package used here. */
export type SpeechPackage = Pick<
  typeof import('expo-speech'),
  'speak' | 'stop' | 'getAvailableVoicesAsync'
>;

/** The clearest installed voice for the language: an enhanced one, the exact locale first. */
export function bestVoice(voices: Voice[], lang: string): string | undefined {
  const language = lang.split('-')[0];
  const enhanced = voices.filter((voice) => voice.quality === 'Enhanced');
  const exact = enhanced.find((voice) => voice.language === lang);
  return (exact ?? enhanced.find((voice) => voice.language.split('-')[0] === language))?.identifier;
}

/** The phone's speech voice, loaded on first use. */
export class NativeSpeaker implements Speaker {
  private loaded: SpeechPackage | null = null;
  private voice: string | undefined;

  constructor(
    private readonly load: () => SpeechPackage,
    private readonly lang = deviceLocale(),
  ) {}

  /** `speak` returns nothing and may throw, so a throw is told as a line not said. */
  say(text: string, done: (finished: boolean) => void): void {
    try {
      this.speech().speak(text, {
        language: this.lang,
        voice: this.voice,
        // The system's own audio session for speech, so ending a recognition can't cut it off.
        useApplicationAudioSession: false,
        onDone: () => done(true),
        onStopped: () => done(false),
        onError: () => done(false),
      });
    } catch {
      done(false);
    }
  }

  hush(): void {
    try {
      void this.speech()
        .stop()
        .catch(() => undefined);
    } catch {
      // Speech never loaded, so nothing is speaking.
    }
  }

  private speech(): SpeechPackage {
    if (this.loaded) return this.loaded;
    const speech = this.load();
    this.loaded = speech;
    void speech
      .getAvailableVoicesAsync()
      .then((voices) => (this.voice = bestVoice(voices, this.lang)))
      .catch(() => undefined);
    return speech;
  }
}

/** Loads the speech package. Use only once voice mode is known to be available: the package
 *  throws on import when the installed build lacks its native module. */
function loadSpeech(): SpeechPackage {
  // SAFETY: a plain require keeps the package out of the app's start-up; its types are the package's own.
  return require('expo-speech') as SpeechPackage;
}

export const nativeSpeaker = new NativeSpeaker(loadSpeech);
