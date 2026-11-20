import { mergeDictation } from './merge';

export type RecognitionEvents = {
  started: () => void;
  result: (transcript: string, isFinal: boolean) => void;
  error: (code: string) => void;
  end: () => void;
};

/** One recognition, from the caller's side. */
export type RecognitionSession = {
  /** Finishes the current words, then ends. */
  stop: () => void;
  /** Ends at once, with no further results. */
  abort: () => void;
};

/** One speech recognizer; only one recognition runs at a time. */
export type Recognizer = {
  requestPermission: () => Promise<boolean>;
  /** Begins once any earlier recognition has ended; `events` then hears only this one. */
  start: (events: RecognitionEvents) => RecognitionSession;
};

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'stopping';
export type DictationState = { phase: DictationPhase; notice: string | null };

type DictationDeps = {
  recognizer: Recognizer;
  read: () => string;
  write: (text: string) => void;
  onChange: (state: DictationState) => void;
};

export const IDLE: DictationState = { phase: 'idle', notice: null };
/** Listening stops after this long without new words. */
export const SILENCE_MS = 8000;
/** A stop that never reports its end is cut off after this long. */
export const STOP_GRACE_MS = 3000;
/** A start that never reports listening or failing is given up after this long. */
export const START_TIMEOUT_MS = 5000;

export const NOTICES = {
  denied: 'To dictate, allow Frink to use the microphone and speech recognition in Settings.',
  language: "Dictation isn't available in this iPhone's language.",
  busy: 'The microphone is still finishing the last dictation. Try again in a moment.',
  failed: 'Dictation stopped. Tap the microphone to try again.',
};

/** What to tell the user when recognition fails; nothing when it simply stopped or heard nothing. */
export function errorNotice(code: string): string | null {
  if (code === 'aborted' || code === 'no-speech' || code === 'speech-timeout') return null;
  if (code === 'not-allowed' || code === 'service-not-allowed') return NOTICES.denied;
  if (code === 'language-not-supported') return NOTICES.language;
  if (code === 'busy') return NOTICES.busy;
  return NOTICES.failed;
}

/** Writes dictated words into a draft. Each session has a fresh id, so events that arrive after it
 *  ended are ignored, and every phase has a way back to idle. */
export class Dictation {
  private state = IDLE;
  private session = 0;
  private base = '';
  private written = '';
  private recognition: RecognitionSession | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: DictationDeps) {}

  get phase(): DictationPhase {
    return this.state.phase;
  }

  async start(): Promise<void> {
    if (this.phase !== 'idle') return;
    const session = ++this.session;
    this.base = this.written = this.deps.read();
    this.set({ phase: 'starting', notice: null });
    const granted = await this.deps.recognizer.requestPermission().catch(() => false);
    if (session !== this.session) return;
    if (!granted) return this.finish(NOTICES.denied);
    this.arm(START_TIMEOUT_MS, () => this.abort(NOTICES.failed));
    try {
      const recognition = this.deps.recognizer.start(this.events(session));
      if (session === this.session) this.recognition = recognition;
    } catch {
      this.finish(NOTICES.failed);
    }
  }

  /** The microphone button: starts when idle, otherwise stops. */
  toggle(): void {
    if (this.phase === 'idle') void this.start();
    else this.stop();
  }

  /** Leaving the app ends dictation. "inactive" is ignored: the permission prompt causes it. */
  appStateChanged(state: string): void {
    if (state === 'background') this.abort();
  }

  /** Keeps the words heard so far and ends once the recognizer finishes them. */
  stop(): void {
    if (this.phase === 'idle' || this.phase === 'stopping') return;
    if (this.phase === 'starting') return this.abort();
    this.set({ phase: 'stopping', notice: null });
    this.recognition?.stop();
    this.arm(STOP_GRACE_MS, () => this.abort());
  }

  /** Ends now; a result still on its way is dropped. */
  abort(notice: string | null = null): void {
    if (this.phase === 'idle') return;
    this.recognition?.abort();
    this.finish(notice);
  }

  /** The user changed the draft. While dictating, their edit wins and dictation ends. */
  edited(text: string): void {
    if (this.phase !== 'idle') {
      if (text !== this.written) this.abort();
    } else if (this.state.notice) {
      this.set(IDLE);
    }
  }

  private events(session: number): RecognitionEvents {
    return {
      started: () => this.listening(session),
      result: (transcript, isFinal) => this.result(session, transcript, isFinal),
      error: (code) => this.ended(session, errorNotice(code)),
      end: () => this.ended(session, null),
    };
  }

  private listening(session: number): void {
    if (session !== this.session || this.phase !== 'starting') return;
    this.set({ phase: 'listening', notice: null });
    this.arm(SILENCE_MS, () => this.stop());
  }

  private result(session: number, transcript: string, isFinal: boolean): void {
    if (session !== this.session) return;
    // An empty result carries no words, so it must not take away the ones already shown.
    if (transcript.trim()) {
      this.written = mergeDictation(this.base, transcript);
      this.deps.write(this.written);
    }
    // A final result closes a stretch of speech; the next partials start a new one after it.
    if (isFinal) this.base = this.written;
    if (this.phase === 'listening') this.arm(SILENCE_MS, () => this.stop());
  }

  private ended(session: number, notice: string | null): void {
    if (session === this.session) this.finish(notice);
  }

  private arm(ms: number, action: () => void): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(action, ms);
  }

  private finish(notice: string | null): void {
    this.session++;
    clearTimeout(this.timer);
    this.recognition = null;
    this.set({ phase: 'idle', notice });
  }

  private set(state: DictationState): void {
    this.state = state;
    this.deps.onChange(state);
  }
}
