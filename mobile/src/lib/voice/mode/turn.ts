import { errorNotice } from '../dictation';
import { mergeDictation } from '../merge';
import { decideAnswer, normalize, ON_SCREEN, type Answer, type Decision } from './answer';

/** After words, a pause this long sends them. */
export const COMMIT_MS = 1700;
/** After words ending in a send phrase, a pause this long sends them; more words cancel it. */
export const PHRASE_MS = 600;
/** A recognition that never reports listening is given up after this long. */
export const START_MS = 5000;
/** A recognition asked to finish that never reports its end is cut off after this long. */
export const STOP_MS = 3000;
/** Recognitions that end on their own this many times running stop voice mode. */
const MAX_RESTARTS = 3;
/** Messages this short are noise, not requests. */
const MIN_MESSAGE = 4;

const DENIED_CODES = new Set(['not-allowed', 'service-not-allowed']);
const SEND_PHRASE = /[\s,]*\b(send it|go ahead)[\s.!]*$/i;
/** Words before a send phrase that turn it into its opposite, as in "don't go ahead". */
const NEGATED = /\b(?:don['’]?t|do not|not|never)\s*$/i;

export const VOICE_LINES = {
  notSent: 'That message didn’t send. Tap it in the chat to try again.',
  answerFailed: 'That answer didn’t go through. Say it again, or answer on screen.',
  allowed: 'Allowed.',
  denied: 'Denied.',
  chosen: 'Sent.',
};
export const VOICE_NOTICES = {
  paused: 'Paused. Tap to carry on.',
  denied: 'To talk to Frink, allow the microphone and speech recognition in Settings.',
  stopped: 'Voice mode stopped listening. Tap to carry on.',
  speech: 'Frink couldn’t read the reply aloud. Tap to carry on.',
};

/** The microphone, as this machine has asked for it. `ending` with `commit` sends its words. */
type Mic =
  | { phase: 'off' }
  | { phase: 'starting'; since: number }
  | { phase: 'on' }
  | { phase: 'ending'; since: number; commit: boolean };
/** A sentence to say; `asks` is the decision it reads out, which may be answered once it is said. */
type Line = { text: string; asks?: string };
/** The utterance being heard: `base` is what finished stretches already gave; `during` is the
 *  decision open when it began, the only one its words may answer. */
type Heard = { base: string; text: string; final: boolean; at: number; during: string | null };

export type VoiceState = {
  paused: boolean;
  notice: string | null;
  mic: Mic;
  heard: Heard;
  saying: { id: number; line: Line } | null;
  queue: Line[];
  /** The last utterance id handed out; ids are never reused. */
  lastId: number;
  lastSaid: string;
  decision: Decision | null;
  /** The decision whose question was read out in full: what is said next answers it. */
  asked: string | null;
  /** The decision a spoken answer was sent for. */
  answered: string | null;
  restarts: number;
};

export type VoiceEvent =
  | { type: 'resume' }
  | { type: 'pause'; notice: string | null }
  | { type: 'tap' }
  | { type: 'micStarted' }
  | { type: 'heard'; text: string; final: boolean }
  | { type: 'micError'; code: string }
  | { type: 'micEnded' }
  | { type: 'said'; id: number }
  | { type: 'sayFailed'; id: number }
  | { type: 'reply'; lines: string[] }
  | { type: 'decision'; decision: Decision | null }
  | { type: 'notSent' }
  /** `decision` is the id of the decision the failed answer was for. */
  | { type: 'answerFailed'; decision: string }
  | { type: 'tick' };

export type VoiceEffect =
  | { type: 'listen' }
  /** Finish the words in progress, then end. */
  | { type: 'stopListening' }
  | { type: 'abortListening' }
  | { type: 'say'; id: number; text: string }
  | { type: 'hush' }
  | { type: 'send'; text: string }
  | { type: 'answer'; answer: Answer; decision: string };

const NOTHING_HEARD: Heard = { base: '', text: '', final: false, at: 0, during: null };

export const PAUSED: VoiceState = {
  paused: true,
  notice: null,
  mic: { phase: 'off' },
  heard: NOTHING_HEARD,
  saying: null,
  queue: [],
  lastId: 0,
  lastSaid: '',
  decision: null,
  asked: null,
  answered: null,
  restarts: 0,
};

type Step = { state: VoiceState; effects: VoiceEffect[] };

/** Whether `text` ends by saying to send it, and not by saying not to. */
function endsWithSendPhrase(text: string): boolean {
  const match = SEND_PHRASE.exec(text);
  return !!match && !NEGATED.test(text.slice(0, match.index));
}

/** The words a message keeps: a trailing "send it" or "go ahead" only said when to send. */
export function withoutSendPhrase(text: string): string {
  return (endsWithSendPhrase(text) ? text.replace(SEND_PHRASE, '') : text).trim();
}

/** When the machine next needs a `tick`, or null when nothing is timed. */
export function deadline({ mic, heard }: VoiceState): number | null {
  if (mic.phase === 'starting') return mic.since + START_MS;
  if (mic.phase === 'ending') return mic.since + STOP_MS;
  if (mic.phase !== 'on' || !heard.text) return null;
  const phrase = !heard.during && endsWithSendPhrase(heard.text);
  return heard.at + (phrase ? PHRASE_MS : COMMIT_MS);
}

/** Stops the microphone and speech; lines not yet said, or cut off, are kept for resuming. */
function pause(state: VoiceState, notice: string | null): Step {
  const effects: VoiceEffect[] = [];
  if (state.mic.phase !== 'off') effects.push({ type: 'abortListening' });
  if (state.saying) effects.push({ type: 'hush' });
  const unsaid = state.saying ? [state.saying.line, ...state.queue] : state.queue;
  return {
    state: {
      ...PAUSED,
      queue: unsaid.filter((line) => !line.asks),
      lastId: state.lastId,
      decision: state.decision,
      answered: state.answered,
      notice,
    },
    effects,
  };
}

/** Speaking needs the microphone off: stop it, wait for it, or say the next line. */
function speakNext(state: VoiceState, now: number): Step {
  if (state.mic.phase === 'on')
    return {
      state: { ...state, mic: { phase: 'ending', since: now, commit: false } },
      effects: [{ type: 'stopListening' }],
    };
  if (state.mic.phase !== 'off') return { state, effects: [] };
  const [line, ...queue] = state.queue;
  const id = state.lastId + 1;
  return {
    state: { ...state, queue, lastId: id, saying: { id, line } },
    effects: [{ type: 'say', id, text: line.text }],
  };
}

/** Whether the user is mid-utterance, so a reply waits until they finish. */
function talking({ heard, mic }: VoiceState): boolean {
  return !!heard.text || (mic.phase === 'ending' && mic.commit);
}

/** Moves toward what the state wants: say the next line with the microphone off, else listen. */
function settle({ state, effects }: Step, now: number): Step {
  if (state.paused || state.saying) return { state, effects };
  let next: Step;
  if (state.queue.length && !talking(state)) next = speakNext(state, now);
  else if (state.mic.phase === 'off')
    next = {
      state: { ...state, mic: { phase: 'starting', since: now } },
      effects: [{ type: 'listen' }],
    };
  else return { state, effects };
  return { state: next.state, effects: [...effects, ...next.effects] };
}

const say = (state: VoiceState, text: string): VoiceState => ({
  ...state,
  queue: [...state.queue, { text }],
});

/** Speech that answered nothing: a request not yet heard in full is read out again, so even a
 *  short "yes" leads to it; otherwise the answer belongs on screen, and noise changes nothing. */
function unanswered(state: VoiceState, decision: Decision, heard: Heard): VoiceState {
  const unheard = decision.ask && state.asked !== decision.id;
  if (!unheard) return heard.text.trim().length < MIN_MESSAGE ? state : say(state, ON_SCREEN);
  const queued = state.queue.some((line) => line.asks === decision.id);
  return queued
    ? state
    : { ...state, queue: [...state.queue, { text: decision.line, asks: decision.id }] };
}

/**
 * While a decision is open, speech only answers it. An answer counts once the decision was read
 * out in full; anything unclear changes nothing.
 */
function answerDecision(state: VoiceState, decision: Decision, heard: Heard): Step {
  if (state.answered === decision.id) return { state, effects: [] };
  const asked = decision.ask && state.asked === decision.id ? decision.ask : null;
  const answer = asked ? decideAnswer(asked, heard.text, heard.final) : null;
  if (!answer) return { state: unanswered(state, decision, heard), effects: [] };
  const line =
    answer.kind === 'question'
      ? VOICE_LINES.chosen
      : answer.approved
        ? VOICE_LINES.allowed
        : VOICE_LINES.denied;
  return {
    state: say({ ...state, answered: decision.id }, line),
    effects: [{ type: 'answer', answer, decision: decision.id }],
  };
}

/** The finished utterance: an answer to the decision open as it began, otherwise a message. */
function commit(state: VoiceState): Step {
  const { heard, decision } = state;
  const cleared = { ...state, heard: NOTHING_HEARD };
  if (heard.during)
    return decision?.id === heard.during
      ? answerDecision(cleared, decision, heard)
      : { state: cleared, effects: [] };
  const text = withoutSendPhrase(heard.text);
  const echo = normalize(text) === normalize(state.lastSaid);
  if (text.length < MIN_MESSAGE || echo) return { state: cleared, effects: [] };
  return { state: cleared, effects: [{ type: 'send', text }] };
}

/** Asks the recognizer to finish the words in progress, which are then committed. */
function finishWords(state: VoiceState, now: number): Step {
  return {
    state: { ...state, mic: { phase: 'ending', since: now, commit: true } },
    effects: [{ type: 'stopListening' }],
  };
}

function heard(state: VoiceState, text: string, final: boolean, now: number): Step {
  const { mic } = state;
  const open = mic.phase === 'on' || (mic.phase === 'ending' && mic.commit);
  if (!open) return { state, effects: [] };
  const merged = text.trim() ? mergeDictation(state.heard.base, text) : state.heard.text;
  const during = state.heard.text ? state.heard.during : (state.decision?.id ?? null);
  const base = final ? merged : state.heard.base;
  return {
    // Only real words show the microphone works; an empty result keeps the restart count.
    state: {
      ...state,
      restarts: text.trim() ? 0 : state.restarts,
      heard: { base, text: merged, final, at: now, during },
    },
    effects: [],
  };
}

/** Another recognition ended without being asked to, or failed on its own: after a few, stop. */
function restarted(state: VoiceState): Step | null {
  const restarts = state.restarts + 1;
  return restarts > MAX_RESTARTS ? pause(state, VOICE_NOTICES.stopped) : null;
}

/** The recognition ended. Its words are committed when they were asked for, or it ended early. */
function micEnded(state: VoiceState): Step {
  const { mic } = state;
  if (mic.phase === 'off') return { state, effects: [] };
  const off: VoiceState = { ...state, mic: { phase: 'off' } };
  if (mic.phase === 'ending') return mic.commit ? commit(off) : { state: off, effects: [] };
  const stopped = restarted(off);
  if (stopped) return stopped;
  const counted = { ...off, restarts: state.restarts + 1 };
  return state.heard.text ? commit(counted) : { state: counted, effects: [] };
}

function micError(state: VoiceState, code: string, now: number): Step {
  if (errorNotice(code))
    return pause(state, DENIED_CODES.has(code) ? VOICE_NOTICES.denied : VOICE_NOTICES.stopped);
  if (state.mic.phase !== 'on' && state.mic.phase !== 'starting') return { state, effects: [] };
  const stopped = restarted(state);
  if (stopped) return stopped;
  // A recognition that failed this way still reports its end; wait for it before speaking.
  return {
    state: {
      ...state,
      restarts: state.restarts + 1,
      mic: { phase: 'ending', since: now, commit: !!state.heard.text },
    },
    effects: [],
  };
}

function tap(state: VoiceState, now: number): Step {
  // Stopping the reply keeps any request still to be asked.
  if (state.saying) {
    const queue = state.queue.filter((line) => line.asks);
    return { state: { ...state, saying: null, queue }, effects: [{ type: 'hush' }] };
  }
  if (state.mic.phase === 'ending') return { state, effects: [] };
  if (state.mic.phase === 'on' && state.heard.text) return finishWords(state, now);
  return pause(state, VOICE_NOTICES.paused);
}

function tick(state: VoiceState, now: number): Step {
  const due = deadline(state);
  if (due === null || now < due) return { state, effects: [] };
  const { mic } = state;
  if (mic.phase === 'starting') return pause(state, VOICE_NOTICES.stopped);
  if (mic.phase === 'on') return finishWords(state, now);
  const ended = micEnded(state);
  return { state: ended.state, effects: [{ type: 'abortListening' }, ...ended.effects] };
}

function said(state: VoiceState, id: number): Step {
  if (state.saying?.id !== id) return { state, effects: [] };
  const { line } = state.saying;
  const asked = line.asks && line.asks === state.decision?.id ? line.asks : state.asked;
  return {
    state: { ...state, saying: null, lastSaid: line.text, asked, restarts: 0 },
    effects: [],
  };
}

function decision(state: VoiceState, next: Decision | null): Step {
  if (next?.id === state.decision?.id) return { state, effects: [] };
  const queue = state.queue.filter((line) => !line.asks);
  if (next && !state.paused) queue.push({ text: next.line, asks: next.id });
  return {
    state: { ...state, decision: next, queue, asked: null, answered: null },
    effects: [],
  };
}

function resume(state: VoiceState): Step {
  if (!state.paused) return { state, effects: [] };
  const { decision } = state;
  const ask = decision && state.answered !== decision.id;
  const queue = ask ? [...state.queue, { text: decision.line, asks: decision.id }] : state.queue;
  return { state: { ...state, paused: false, notice: null, queue }, effects: [] };
}

const unchanged = (state: VoiceState): Step => ({ state, effects: [] });
type Handlers = {
  [K in VoiceEvent['type']]: (
    state: VoiceState,
    event: Extract<VoiceEvent, { type: K }>,
    now: number,
  ) => Step;
};

/** How each event changes the state, before `settle` moves it on. */
const HANDLERS: Handlers = {
  resume,
  pause: (state, event) => pause(state, event.notice),
  tap: (state, _event, now) => (state.paused ? unchanged(state) : tap(state, now)),
  micStarted: (state) =>
    state.mic.phase === 'starting'
      ? unchanged({ ...state, mic: { phase: 'on' } })
      : unchanged(state),
  heard: (state, event, now) => heard(state, event.text, event.final, now),
  micError: (state, event, now) => micError(state, event.code, now),
  micEnded,
  said: (state, event) => said(state, event.id),
  sayFailed: (state, event) =>
    state.saying?.id === event.id ? pause(state, VOICE_NOTICES.speech) : unchanged(state),
  reply: (state, event) =>
    unchanged({ ...state, queue: [...state.queue, ...event.lines.map((text) => ({ text }))] }),
  decision: (state, event) => decision(state, event.decision),
  notSent: (state) => unchanged(say(state, VOICE_LINES.notSent)),
  answerFailed: (state, event) => {
    if (state.answered !== event.decision) return unchanged(state);
    const retry = { ...state, answered: null };
    return unchanged(state.paused ? retry : say(retry, VOICE_LINES.answerFailed));
  },
  tick: (state, _event, now) => tick(state, now),
};

function apply<K extends VoiceEvent['type']>(
  state: VoiceState,
  event: Extract<VoiceEvent, { type: K }>,
  now: number,
): Step {
  const handle: Handlers[K] = HANDLERS[event.type];
  return handle(state, event, now);
}

/** What the big button does now; it matches how `tap` is handled. */
export type VoiceControl = 'resume' | 'interrupt' | 'send' | 'wait' | 'pause';

export function voiceControl(state: VoiceState): VoiceControl {
  if (state.paused) return 'resume';
  if (state.saying) return 'interrupt';
  if (state.mic.phase === 'ending') return 'wait';
  return state.mic.phase === 'on' && state.heard.text ? 'send' : 'pause';
}

/** What voice mode is doing, in a few words. */
export function voiceStatus(state: VoiceState, running: boolean): string {
  if (state.paused) return 'Paused';
  if (state.saying) return 'Speaking';
  return running ? 'Frink is working. Talk to guide it.' : 'Listening';
}

/** One step of voice mode: the next state and what to do. It never listens while speaking. */
export function step(state: VoiceState, event: VoiceEvent, now: number): Step {
  return settle(apply(state, event, now), now);
}
