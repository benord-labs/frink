import type { RecognitionEvents, RecognitionSession, Recognizer } from '../dictation';
import type { Answer, Decision } from './answer';
import type { Speaker } from './speaker';
import {
  VOICE_NOTICES,
  PAUSED,
  deadline,
  step,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from './turn';

type SessionDeps = {
  recognizer: Recognizer;
  speaker: Speaker;
  /** Resolves false when the message did not reach the computer. */
  send: (text: string) => Promise<boolean>;
  /** Resolves false when the answer did not reach the computer. */
  answer: (answer: Answer) => Promise<boolean>;
  onChange: (state: VoiceState) => void;
};

/** Whether a delivery did not reach the computer; a throw or rejection counts as not reaching it. */
function failed(deliver: () => Promise<boolean>): Promise<boolean> {
  try {
    return deliver().then(
      (reached) => !reached,
      () => true,
    );
  } catch {
    return Promise.resolve(true);
  }
}

/** The recognition this session is listening through; events from any other are ignored. */
type Live = { events: RecognitionEvents; session: RecognitionSession | null };

/**
 * Runs voice mode's turn machine against the real microphone, speaker and timer. Events are
 * handled one at a time, in order, even when one arrives while another is being handled.
 */
export class VoiceSession {
  private state = PAUSED;
  private inbox: VoiceEvent[] = [];
  private handling = false;
  private live: Live | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private due: number | null = null;
  private resumes = 0;
  private closed = false;

  constructor(private readonly deps: SessionDeps) {}

  /** Starts listening once the microphone and speech recognition are allowed. */
  async resume(): Promise<void> {
    if (this.closed || !this.state.paused) return;
    const attempt = ++this.resumes;
    const granted = await this.deps.recognizer.requestPermission().catch(() => false);
    if (attempt !== this.resumes) return;
    this.dispatch(granted ? { type: 'resume' } : { type: 'pause', notice: VOICE_NOTICES.denied });
  }

  /** The big button: carries on when paused, otherwise interrupts, sends or pauses. */
  tap(): void {
    if (this.state.paused) void this.resume();
    else this.dispatch({ type: 'tap' });
  }

  pause(notice: string | null = VOICE_NOTICES.paused): void {
    this.resumes++;
    this.dispatch({ type: 'pause', notice });
  }

  reply(lines: string[]): void {
    this.dispatch({ type: 'reply', lines });
  }

  /** One snapshot of the chat: its new reply sentences are said, then its open decision asked. */
  snapshot(lines: string[], decision: Decision | null): void {
    if (lines.length) this.reply(lines);
    this.decision(decision);
  }

  decision(decision: Decision | null): void {
    this.dispatch({ type: 'decision', decision });
  }

  /** Stops listening and speaking for good; nothing it started outlives this. */
  close(): void {
    this.pause(null);
    this.closed = true;
    clearTimeout(this.timer);
  }

  private dispatch(event: VoiceEvent): void {
    if (this.closed) return;
    this.inbox.push(event);
    if (this.handling) return;
    this.handling = true;
    const before = this.state;
    for (let next = this.inbox.shift(); next; next = this.inbox.shift()) {
      const { state, effects } = step(this.state, next, Date.now());
      this.state = state;
      effects.forEach((effect) => this.attempt(effect));
    }
    this.handling = false;
    this.arm();
    if (this.state !== before) this.deps.onChange(this.state);
  }

  /** One timer, set for the machine's next deadline and replaced whenever that changes. */
  private arm(): void {
    const due = this.closed ? null : deadline(this.state);
    if (due === this.due) return;
    clearTimeout(this.timer);
    this.due = due;
    if (due === null) return;
    this.timer = setTimeout(
      () => {
        this.due = null;
        this.dispatch({ type: 'tick' });
      },
      Math.max(0, due - Date.now()),
    );
  }

  /** An effect that throws loses only its own work; a line that could not start is told as unsaid. */
  private attempt(effect: VoiceEffect): void {
    try {
      this.run(effect);
    } catch {
      if (effect.type === 'say') this.dispatch({ type: 'sayFailed', id: effect.id });
    }
  }

  private run(effect: VoiceEffect): void {
    switch (effect.type) {
      case 'listen':
        return this.listen();
      case 'stopListening':
        return this.live?.session?.stop();
      case 'abortListening': {
        const live = this.live;
        this.live = null;
        return live?.session?.abort();
      }
      case 'say': {
        const { id } = effect;
        return this.deps.speaker.say(effect.text, (finished) =>
          this.dispatch(finished ? { type: 'said', id } : { type: 'sayFailed', id }),
        );
      }
      case 'hush':
        return this.deps.speaker.hush();
      case 'send':
        return void failed(() => this.deps.send(effect.text)).then((lost) => {
          if (lost) this.dispatch({ type: 'notSent' });
        });
      case 'answer':
        return void failed(() => this.deps.answer(effect.answer)).then((lost) => {
          if (lost) this.dispatch({ type: 'answerFailed', decision: effect.decision });
        });
    }
  }

  private listen(): void {
    const events: RecognitionEvents = {
      started: () => this.from(events, { type: 'micStarted' }),
      result: (text, final) => this.from(events, { type: 'heard', text, final }),
      error: (code) => this.from(events, { type: 'micError', code }),
      end: () => this.from(events, { type: 'micEnded' }),
    };
    const live: Live = { events, session: null };
    this.live = live;
    try {
      live.session = this.deps.recognizer.start(events);
    } catch {
      this.from(events, { type: 'micError', code: 'start-failed' });
    }
  }

  private from(events: RecognitionEvents, event: VoiceEvent): void {
    if (this.live?.events !== events) return;
    if (event.type === 'micEnded') this.live = null;
    this.dispatch(event);
  }
}
