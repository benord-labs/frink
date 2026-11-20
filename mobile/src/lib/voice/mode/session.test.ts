import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { RecognitionEvents, Recognizer } from '../dictation';
import type { Answer, Decision } from './answer';
import { VoiceSession } from './session';
import type { Speaker } from './speaker';
import { COMMIT_MS, VOICE_LINES, VOICE_NOTICES, type VoiceState } from './turn';

type Spoken = { text: string; done: (finished: boolean) => void };
type Harness = {
  session: VoiceSession;
  /** Every recognition started, newest last. */
  recognitions: Array<{
    events: RecognitionEvents;
    stop: Mock<() => void>;
    abort: Mock<() => void>;
  }>;
  spoken: Spoken[];
  hush: Mock<() => void>;
  send: Mock<(text: string) => Promise<boolean>>;
  answer: Mock<(answer: Answer) => Promise<boolean>>;
  states: VoiceState[];
  grant: (granted: boolean) => Promise<void>;
};

function harness(
  start?: (events: RecognitionEvents) => void,
  onSay?: (done: (finished: boolean) => void) => void,
): Harness {
  let grant: (granted: boolean) => void = () => {};
  const recognitions: Harness['recognitions'] = [];
  const recognizer: Recognizer = {
    requestPermission: () => new Promise<boolean>((resolve) => (grant = resolve)),
    start: (events) => {
      const recognition = { events, stop: vi.fn(), abort: vi.fn() };
      recognitions.push(recognition);
      start?.(events);
      return { stop: recognition.stop, abort: recognition.abort };
    },
  };
  const spoken: Spoken[] = [];
  const hush = vi.fn();
  const speaker: Speaker = {
    say: (text, done) => {
      spoken.push({ text, done });
      onSay?.(done);
    },
    hush,
  };
  const send = vi.fn((_text: string) => Promise.resolve(true));
  const answer = vi.fn((_answer: Answer) => Promise.resolve(true));
  const states: VoiceState[] = [];
  const session = new VoiceSession({
    recognizer,
    speaker,
    send,
    answer,
    onChange: (state) => states.push(state),
  });
  return {
    session,
    recognitions,
    spoken,
    hush,
    send,
    answer,
    states,
    grant: async (granted) => {
      const resumed = session.resume();
      grant(granted);
      await resumed;
    },
  };
}

const last = <T>(items: T[]): T => {
  const item = items.at(-1);
  if (item === undefined) throw new Error('nothing yet');
  return item;
};

/** A harness that is listening through its first recognition. */
async function listening(): Promise<Harness> {
  const h = harness();
  await h.grant(true);
  last(h.recognitions).events.started();
  return h;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('says how to allow the microphone when it is refused, and never listens', async () => {
  const h = harness();
  await h.grant(false);
  expect(h.recognitions).toEqual([]);
  expect(last(h.states)).toMatchObject({ paused: true, notice: VOICE_NOTICES.denied });
});

it('sends what was said after the pause, once, then listens through a new recognition', async () => {
  const h = await listening();
  const first = last(h.recognitions);
  first.events.result('add a test', false);
  vi.advanceTimersByTime(COMMIT_MS - 1);
  expect(first.stop).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(first.stop).toHaveBeenCalledTimes(1);
  first.events.result('Add a test.', true);
  first.events.end();
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.send).toHaveBeenCalledWith('Add a test.');
  expect(h.recognitions).toHaveLength(2);
  // The finished recognition can't reach the new one.
  first.events.result('Add a test.', true);
  first.events.end();
  vi.advanceTimersByTime(10_000);
  expect(h.send).toHaveBeenCalledTimes(1);
});

it('speaks the reply only after the microphone ended, then listens again', async () => {
  const h = await listening();
  const first = last(h.recognitions);
  h.session.reply(['Here is the answer.']);
  expect(first.stop).toHaveBeenCalled();
  expect(h.spoken).toEqual([]);
  first.events.end();
  expect(h.spoken.map((line) => line.text)).toEqual(['Here is the answer.']);
  expect(h.recognitions).toHaveLength(1);
  last(h.spoken).done(true);
  expect(h.recognitions).toHaveLength(2);
});

it.each([
  ['resolves false', (h: Harness) => h.send.mockResolvedValueOnce(false)],
  ['rejects', (h: Harness) => h.send.mockRejectedValueOnce(new Error('offline'))],
  [
    'throws',
    (h: Harness) =>
      h.send.mockImplementationOnce(() => {
        throw new Error('offline');
      }),
  ],
])('says so when sending a spoken message %s', async (_how, fail) => {
  const h = await listening();
  fail(h);
  const first = last(h.recognitions);
  first.events.result('deploy the app', false);
  vi.advanceTimersByTime(COMMIT_MS);
  first.events.end();
  await vi.advanceTimersByTimeAsync(0);
  last(h.recognitions).events.started();
  last(h.recognitions).events.end();
  expect(h.spoken.map((line) => line.text)).toEqual([VOICE_LINES.notSent]);
});

it('answers a request read out in full, and says so when the answer fails', async () => {
  const h = await listening();
  const decision: Decision = {
    id: 'permission:p1',
    line: 'Allow?',
    ask: { kind: 'permission', id: 'p1' },
  };
  h.session.decision(decision);
  last(h.recognitions).events.end();
  last(h.spoken).done(true);
  const answering = last(h.recognitions);
  answering.events.started();
  answering.events.result('allow', false);
  vi.advanceTimersByTime(COMMIT_MS);
  h.answer.mockResolvedValueOnce(false);
  answering.events.result('Allow.', true);
  answering.events.end();
  expect(h.answer).toHaveBeenCalledTimes(1);
  expect(h.answer).toHaveBeenCalledWith({ kind: 'permission', id: 'p1', approved: true });
  await vi.advanceTimersByTimeAsync(0);
  last(h.spoken).done(true);
  expect(h.spoken.map((line) => line.text)).toEqual([
    'Allow?',
    VOICE_LINES.allowed,
    VOICE_LINES.answerFailed,
  ]);
});

it('closing stops listening and speaking, and leaves no timer or late event behind', async () => {
  const h = await listening();
  const first = last(h.recognitions);
  first.events.result('half a thought', false);
  h.session.close();
  expect(first.abort).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  first.events.result('more', false);
  first.events.end();
  h.session.reply(['Late.']);
  h.session.tap();
  expect(h.recognitions).toHaveLength(1);
  expect(h.spoken).toEqual([]);
  expect(h.send).not.toHaveBeenCalled();
});

it('closing while speaking hushes the speaker', async () => {
  const h = await listening();
  h.session.reply(['Long reply.']);
  last(h.recognitions).events.end();
  h.session.close();
  expect(h.hush).toHaveBeenCalledTimes(1);
  last(h.spoken).done(false);
  expect(h.recognitions).toHaveLength(1);
});

it('a pause while permission is being asked wins over the answer', async () => {
  const h = harness();
  const resumed = h.grant(true);
  h.session.pause();
  await resumed;
  expect(h.recognitions).toEqual([]);
  expect(last(h.states).paused).toBe(true);
});

it('tap carries on after a pause', async () => {
  const h = await listening();
  h.session.pause();
  expect(last(h.recognitions).abort).toHaveBeenCalled();
  h.session.tap();
  await h.grant(true);
  expect(h.recognitions).toHaveLength(2);
});

it('a recognizer that fails as it starts pauses voice mode', async () => {
  const h = harness((events) => events.error('start-failed'));
  await h.grant(true);
  expect(last(h.states)).toMatchObject({ paused: true, notice: VOICE_NOTICES.stopped });
  expect(last(h.recognitions).abort).toHaveBeenCalled();
});

it('a recognizer that throws on start pauses voice mode', async () => {
  const h = harness(() => {
    throw new Error('no module');
  });
  await h.grant(true);
  expect(last(h.states)).toMatchObject({ paused: true, notice: VOICE_NOTICES.stopped });
});

it('a line the speaker fails at once pauses voice mode instead of sticking', async () => {
  let fails = 1;
  const h = harness(undefined, (done) => fails-- > 0 && done(false));
  await h.grant(true);
  last(h.recognitions).events.started();
  h.session.reply(['Hello.']);
  last(h.recognitions).events.end();
  expect(last(h.states)).toMatchObject({ paused: true, notice: VOICE_NOTICES.speech });
  await h.grant(true);
  last(h.spoken).done(true);
  expect(h.spoken.map((line) => line.text)).toEqual(['Hello.', 'Hello.']);
  expect(h.recognitions).toHaveLength(2);
});

it('a recognizer that throws on stop does not stop voice mode handling events', async () => {
  const h = await listening();
  last(h.recognitions).stop.mockImplementation(() => {
    throw new Error('native');
  });
  h.session.reply(['Hello.']);
  vi.advanceTimersByTime(3000);
  expect(h.spoken.map((line) => line.text)).toEqual(['Hello.']);
});

it('a speaker that throws as a line starts pauses voice mode instead of sticking', async () => {
  const h = harness(undefined, () => {
    throw new Error('native');
  });
  await h.grant(true);
  last(h.recognitions).events.started();
  h.session.reply(['Hello.']);
  last(h.recognitions).events.end();
  expect(last(h.states)).toMatchObject({ paused: true, notice: VOICE_NOTICES.speech });
});

it('a snapshot says its new lines before asking its decision, and an empty one changes nothing', async () => {
  const h = await listening();
  const before = h.states.length;
  h.session.snapshot([], null);
  expect(h.states).toHaveLength(before);
  h.session.snapshot(['Done.'], { id: 'permission:p1', line: 'Allow?', ask: null });
  last(h.recognitions).events.end();
  last(h.spoken).done(true);
  expect(h.spoken.map((line) => line.text)).toEqual(['Done.', 'Allow?']);
});
