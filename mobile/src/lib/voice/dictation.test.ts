import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  Dictation,
  NOTICES,
  SILENCE_MS,
  START_TIMEOUT_MS,
  STOP_GRACE_MS,
  errorNotice,
  type DictationState,
  type RecognitionEvents,
  type Recognizer,
} from './dictation';

type Harness = {
  dictation: Dictation;
  draft: { text: string };
  states: DictationState[];
  recognizer: Recognizer & {
    events: RecognitionEvents | null;
    stop: Mock<() => void>;
    abort: Mock<() => void>;
  };
  grant: (granted: boolean) => void;
};

function harness(initial = ''): Harness {
  const draft = { text: initial };
  const states: DictationState[] = [];
  let grant: (granted: boolean) => void = () => {};
  const recognizer: Harness['recognizer'] = {
    events: null,
    requestPermission: () => new Promise<boolean>((resolve) => (grant = resolve)),
    start: vi.fn((events: RecognitionEvents) => {
      recognizer.events = events;
      return { stop: recognizer.stop, abort: recognizer.abort };
    }),
    stop: vi.fn(),
    abort: vi.fn(),
  };
  const dictation = new Dictation({
    recognizer,
    read: () => draft.text,
    write: (text) => (draft.text = text),
    onChange: (state) => states.push(state),
  });
  return { dictation, draft, states, recognizer, grant: (granted) => grant(granted) };
}

async function listening(initial = ''): Promise<Harness> {
  const h = harness(initial);
  const started = h.dictation.start();
  h.grant(true);
  await started;
  h.recognizer.events!.started();
  return h;
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('Dictation', () => {
  it('shows partial words live and keeps them after a final result', async () => {
    const h = await listening('Hi');
    expect(h.dictation.phase).toBe('listening');
    h.recognizer.events!.result('can you', false);
    expect(h.draft.text).toBe('Hi can you');
    h.recognizer.events!.result('can you check', false);
    expect(h.draft.text).toBe('Hi can you check');
    h.recognizer.events!.result('can you check.', true);
    h.recognizer.events!.result('thanks', false);
    expect(h.draft.text).toBe('Hi can you check. Thanks');
  });

  it('stops on the second tap, keeps the last words, and ends idle', async () => {
    const h = await listening();
    h.dictation.stop();
    expect(h.dictation.phase).toBe('stopping');
    expect(h.recognizer.stop).toHaveBeenCalled();
    h.recognizer.events!.result('last words', true);
    h.recognizer.events!.end();
    expect(h.draft.text).toBe('Last words');
    expect(h.dictation.phase).toBe('idle');
  });

  it('gives up on a stop whose end never arrives', async () => {
    const h = await listening();
    h.dictation.stop();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(h.recognizer.abort).toHaveBeenCalled();
    expect(h.dictation.phase).toBe('idle');
  });

  it('stops by itself after a stretch of silence, which new words push back', async () => {
    const h = await listening();
    vi.advanceTimersByTime(SILENCE_MS - 1);
    h.recognizer.events!.result('still here', false);
    vi.advanceTimersByTime(SILENCE_MS - 1);
    expect(h.dictation.phase).toBe('listening');
    vi.advanceTimersByTime(1);
    expect(h.dictation.phase).toBe('stopping');
  });

  it('lets a user edit win: dictation ends and a late result cannot overwrite it', async () => {
    const h = await listening();
    h.recognizer.events!.result('hello', false);
    h.dictation.edited('Hello');
    expect(h.dictation.phase).toBe('listening');
    h.draft.text = 'Hello there';
    h.dictation.edited('Hello there');
    expect(h.recognizer.abort).toHaveBeenCalled();
    expect(h.dictation.phase).toBe('idle');
    h.recognizer.events!.result('hello world', true);
    expect(h.draft.text).toBe('Hello there');
  });

  it('drops results after an abort, as when Send is tapped', async () => {
    const h = await listening();
    h.dictation.abort();
    h.draft.text = '';
    h.recognizer.events!.result('too late', true);
    h.recognizer.events!.end();
    expect(h.draft.text).toBe('');
    expect(h.states.at(-1)).toEqual({ phase: 'idle', notice: null });
  });

  it('explains a denied permission and never starts the recognizer', async () => {
    const h = harness();
    const started = h.dictation.start();
    expect(h.dictation.phase).toBe('starting');
    h.grant(false);
    await started;
    expect(h.recognizer.start).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual({ phase: 'idle', notice: NOTICES.denied });
    h.dictation.edited('typing');
    expect(h.states.at(-1)).toEqual({ phase: 'idle', notice: null });
  });

  it('treats a failed permission request as denied', async () => {
    const h = harness();
    h.recognizer.requestPermission = () => Promise.reject(new Error('unavailable'));
    await h.dictation.start();
    expect(h.states.at(-1)).toEqual({ phase: 'idle', notice: NOTICES.denied });
  });

  it('ignores a permission answer that arrives after the session was abandoned', async () => {
    const h = harness();
    const started = h.dictation.start();
    h.dictation.stop();
    expect(h.dictation.phase).toBe('idle');
    h.grant(true);
    await started;
    expect(h.recognizer.start).not.toHaveBeenCalled();
    expect(h.dictation.phase).toBe('idle');
  });

  it('ends on a recognition error with a plain notice', async () => {
    const h = await listening();
    h.recognizer.events!.error('audio-capture');
    expect(h.states.at(-1)).toEqual({ phase: 'idle', notice: NOTICES.failed });
  });

  it('starts only one session at a time and can start again once idle', async () => {
    const h = await listening();
    await h.dictation.start();
    expect(h.recognizer.start).toHaveBeenCalledTimes(1);
    h.dictation.abort();
    const again = h.dictation.start();
    h.grant(true);
    await again;
    expect(h.recognizer.start).toHaveBeenCalledTimes(2);
  });

  it('keeps words already shown when a result arrives empty', async () => {
    const h = await listening();
    h.recognizer.events!.result('fix the login', false);
    h.recognizer.events!.result('', false);
    expect(h.draft.text).toBe('Fix the login');
    h.recognizer.events!.result(' ', true);
    h.recognizer.events!.result('page', false);
    expect(h.draft.text).toBe('Fix the login page');
  });

  it('does nothing when stopped or aborted while idle', () => {
    const h = harness();
    h.dictation.stop();
    h.dictation.abort();
    expect(h.states).toEqual([]);
  });
});

describe('Dictation start', () => {
  it('waits for the recognizer to report listening before timing silence', async () => {
    const h = harness();
    const started = h.dictation.start();
    h.grant(true);
    await started;
    expect(h.dictation.phase).toBe('starting');
    h.recognizer.events!.started();
    expect(h.dictation.phase).toBe('listening');
  });

  it('returns to idle with a notice when the recognizer fails to start', async () => {
    const h = harness();
    h.recognizer.start = () => {
      throw new Error('unavailable');
    };
    const started = h.dictation.start();
    h.grant(true);
    await started;
    expect(h.states.at(-1)).toEqual({ phase: 'idle', notice: NOTICES.failed });
  });

  it('gives up on a start that never reports listening or failing', async () => {
    const h = harness();
    const started = h.dictation.start();
    h.grant(true);
    await started;
    vi.advanceTimersByTime(START_TIMEOUT_MS - 1);
    expect(h.dictation.phase).toBe('starting');
    vi.advanceTimersByTime(1);
    expect(h.recognizer.abort).toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual({ phase: 'idle', notice: NOTICES.failed });
    h.recognizer.events!.started();
    expect(h.dictation.phase).toBe('idle');
  });
});

describe('errorNotice', () => {
  it('stays quiet when recognition simply ended', () => {
    expect(errorNotice('aborted')).toBeNull();
    expect(errorNotice('no-speech')).toBeNull();
  });

  it('names the fix for permission and language problems', () => {
    expect(errorNotice('not-allowed')).toBe(NOTICES.denied);
    expect(errorNotice('language-not-supported')).toBe(NOTICES.language);
    expect(errorNotice('busy')).toBe(NOTICES.busy);
    expect(errorNotice('network')).toBe(NOTICES.failed);
  });
});

describe('Dictation exits', () => {
  it('toggles between listening and stopping from the microphone button', async () => {
    const h = harness();
    h.dictation.toggle();
    h.grant(true);
    await vi.waitFor(() => expect(h.recognizer.events).not.toBeNull());
    h.recognizer.events!.started();
    h.dictation.toggle();
    expect(h.dictation.phase).toBe('stopping');
  });

  it('ends when the app goes to the background but not for the permission prompt', async () => {
    const h = harness();
    const started = h.dictation.start();
    h.dictation.appStateChanged('inactive');
    h.grant(true);
    await started;
    h.recognizer.events!.started();
    expect(h.dictation.phase).toBe('listening');
    h.dictation.appStateChanged('background');
    expect(h.dictation.phase).toBe('idle');
    expect(h.recognizer.abort).toHaveBeenCalled();
  });
});
