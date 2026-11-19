import { mergeDictation } from './merge';

export type RecognitionEvents = {
  result: (transcript: string, isFinal: boolean) => void;
  error: (code: string) => void;
  end: () => void;
};

/** One speech recognizer; only one recognition runs at a time. */
export type Recognizer = {
  requestPermission: () => Promise<boolean>;
  /** Returns the function that stops listening. */
  listen: (events: RecognitionEvents) => () => void;
  start: () => void;
  /** Finishes the current words, then ends. */
  stop: () => void;
  /** Ends at once, with no further results. */
  abort: () => void;
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

export const NOTICES = {
  denied: 'To dictate, allow Frink to use the microphone and speech recognition in Settings.',
  language: "Dictation isn't available in this iPhone's language.",
  failed: 'Dictation stopped. Tap the microphone to try again.',
};

/** What to tell the user when recognition fails; nothing when it simply stopped or heard nothing. */
export function errorNotice(code: string): string | null {
  if (code === 'aborted' || code === 'no-speech' || code === 'speech-timeout') return null;
  if (code === 'not-allowed' || code === 'service-not-allowed') return NOTICES.denied;
  if (code === 'language-not-supported') return NOTICES.language;
  return NOTICES.failed;
}

/** Writes dictated words into a draft. Each session has a fresh id, so events that arrive after it
 *  ended are ignored, and every way out returns to idle. */
export class Dictation {
  private state = IDLE;
  private session = 0;
  private base = '';
  private written = '';
  private unlisten: (() => void) | null = null;
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
    this.unlisten = this.deps.recognizer.listen({
      result: (transcript, isFinal) => this.result(session, transcript, isFinal),
      error: (code) => this.ended(session, errorNotice(code)),
      end: () => this.ended(session, null),
    });
    this.deps.recognizer.start();
    this.set({ phase: 'listening', notice: null });
    this.arm(SILENCE_MS, () => this.stop());
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
    this.deps.recognizer.stop();
    this.arm(STOP_GRACE_MS, () => this.abort());
  }

  /** Ends now; a result still on its way is dropped. */
  abort(): void {
    if (this.phase === 'idle') return;
    this.deps.recognizer.abort();
    this.finish(null);
  }

  /** The user changed the draft. While dictating, their edit wins and dictation ends. */
  edited(text: string): void {
    if (this.phase !== 'idle') {
      if (text !== this.written) this.abort();
    } else if (this.state.notice) {
      this.set(IDLE);
    }
  }

  private result(session: number, transcript: string, isFinal: boolean): void {
    if (session !== this.session) return;
    this.written = mergeDictation(this.base, transcript);
    this.deps.write(this.written);
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
    this.unlisten?.();
    this.unlisten = null;
    this.set({ phase: 'idle', notice });
  }

  private set(state: DictationState): void {
    this.state = state;
    this.deps.onChange(state);
  }
}
