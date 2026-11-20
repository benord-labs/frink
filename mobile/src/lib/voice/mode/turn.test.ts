import { describe, expect, it } from 'vitest';
import { ON_SCREEN, type Decision } from './answer';
import {
  COMMIT_MS,
  PHRASE_MS,
  VOICE_LINES,
  VOICE_NOTICES,
  PAUSED,
  START_MS,
  STOP_MS,
  deadline,
  step,
  voiceControl,
  voiceStatus,
  withoutSendPhrase,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from './turn';

type Machine = {
  state: VoiceState;
  /** Applies an event at `now` and returns what the machine asked for. */
  on: (event: VoiceEvent, now?: number) => VoiceEffect[];
};

function machine(): Machine {
  const self: Machine = {
    state: PAUSED,
    on(event, now = 0) {
      const next = step(self.state, event, now);
      self.state = next.state;
      return next.effects;
    },
  };
  return self;
}

/** A machine that is listening, its recognition started. */
function listening(): Machine {
  const m = machine();
  expect(m.on({ type: 'resume' })).toEqual([{ type: 'listen' }]);
  expect(m.on({ type: 'micStarted' })).toEqual([]);
  return m;
}

const heard = (text: string, final = false): VoiceEvent => ({ type: 'heard', text, final });
const sends = (effects: VoiceEffect[]) => effects.filter((effect) => effect.type === 'send');
const answers = (effects: VoiceEffect[]) => effects.filter((effect) => effect.type === 'answer');
const sayId = (effects: VoiceEffect[]) => {
  const say = effects.find((effect) => effect.type === 'say');
  if (say?.type !== 'say') throw new Error('nothing was said');
  return say.id;
};

/** Says the queued line to its end, and returns the effects of finishing it. */
function finishSaying(m: Machine, effects: VoiceEffect[]): VoiceEffect[] {
  return m.on({ type: 'said', id: sayId(effects) });
}

/** Commits the words heard so far with a final result, and returns the end's effects. */
function commitWords(m: Machine, final: string | null, at = 10_000): VoiceEffect[] {
  expect(m.on({ type: 'tick' }, at)).toEqual([{ type: 'stopListening' }]);
  if (final !== null) m.on(heard(final, true), at);
  return m.on({ type: 'micEnded' }, at);
}

const permission: Decision = {
  id: 'permission:p1',
  line: 'Frink is asking permission. The details are on screen. Say allow or deny.',
  ask: { kind: 'permission', id: 'p1' },
};

/** A listening machine that has read `decision` out in full. */
function asked(decision: Decision = permission): Machine {
  const m = listening();
  expect(m.on({ type: 'decision', decision })).toEqual([{ type: 'stopListening' }]);
  const spoken = m.on({ type: 'micEnded' });
  expect(spoken).toEqual([{ type: 'say', id: expect.any(Number), text: decision.line }]);
  expect(finishSaying(m, spoken)).toEqual([{ type: 'listen' }]);
  m.on({ type: 'micStarted' });
  return m;
}

/** What one final utterance does to a machine that asked `decision`. */
function answer(transcript: string, decision: Decision = permission): VoiceEffect[] {
  const m = asked(decision);
  m.on(heard(transcript), 0);
  return commitWords(m, transcript);
}

describe('sending what was said', () => {
  it('sends once after the pause, and a shorter pause does not send', () => {
    const m = listening();
    m.on(heard('fix the'), 0);
    m.on(heard('fix the bug'), 500);
    expect(m.on({ type: 'tick' }, 1500)).toEqual([]);
    expect(m.on({ type: 'tick' }, 500 + COMMIT_MS - 1)).toEqual([]);
    expect(m.on({ type: 'tick' }, 500 + COMMIT_MS)).toEqual([{ type: 'stopListening' }]);
    // The recognizer finishes the words; a later result for them changes nothing.
    m.on(heard('Fix the bug.', true), 2300);
    const ended = m.on({ type: 'micEnded' }, 2400);
    expect(ended).toEqual([{ type: 'send', text: 'Fix the bug.' }, { type: 'listen' }]);
    expect(sends(m.on({ type: 'micEnded' }, 2500))).toEqual([]);
    expect(sends(m.on({ type: 'tick' }, 9000))).toEqual([]);
  });

  it('keeps waiting while words keep coming', () => {
    const m = listening();
    m.on(heard('first'), 0);
    m.on(heard('first part'), 1000);
    expect(m.on({ type: 'tick' }, COMMIT_MS)).toEqual([]);
    expect(deadline(m.state)).toBe(1000 + COMMIT_MS);
  });

  it('sends soon after a trailing send phrase, without the phrase', () => {
    const m = listening();
    expect(m.on(heard('run the tests, send it'), 0)).toEqual([]);
    expect(m.on({ type: 'tick' }, PHRASE_MS)).toEqual([{ type: 'stopListening' }]);
    m.on(heard('Run the tests. Send it.', true), PHRASE_MS);
    expect(sends(m.on({ type: 'micEnded' }))).toEqual([{ type: 'send', text: 'Run the tests.' }]);
    expect(withoutSendPhrase('Deploy it go ahead!')).toBe('Deploy it');
    expect(withoutSendPhrase('Go ahead')).toBe('');
    expect(withoutSendPhrase("Please don't go ahead")).toBe("Please don't go ahead");
    expect(withoutSendPhrase('Do not send it.')).toBe('Do not send it.');
  });

  it('keeps listening when a send phrase starts a sentence', () => {
    const m = listening();
    m.on(heard('Go ahead'), 0);
    m.on(heard('Go ahead and run the tests'), 300);
    expect(m.on({ type: 'tick' }, PHRASE_MS)).toEqual([]);
    expect(m.on({ type: 'tick' }, 300 + PHRASE_MS)).toEqual([]);
    expect(sends(commitWords(m, 'Go ahead and run the tests.', 300 + COMMIT_MS))).toEqual([
      { type: 'send', text: 'Go ahead and run the tests.' },
    ]);
  });

  it('ignores very short transcripts and an echo of its own last line', () => {
    const short = listening();
    short.on(heard('ok'));
    expect(sends(commitWords(short, 'Ok.'))).toEqual([]);

    const echo = listening();
    echo.on({ type: 'reply', lines: ['It is all done.'] });
    const spoken = echo.on({ type: 'micEnded' });
    finishSaying(echo, spoken);
    echo.on({ type: 'micStarted' });
    echo.on(heard('it is all done'));
    expect(sends(commitWords(echo, 'It is all done'))).toEqual([]);
  });

  it('sends words heard before a recognition ended on its own', () => {
    const m = listening();
    m.on(heard('check the logs'));
    const ended = m.on({ type: 'micEnded' });
    expect(ended).toEqual([{ type: 'send', text: 'Check the logs' }, { type: 'listen' }]);
  });

  it('starts a fresh recognition after each message, so its words are never sent twice', () => {
    const m = listening();
    m.on(heard('first message'));
    const ended = commitWords(m, 'First message.');
    expect(ended.at(-1)).toEqual({ type: 'listen' });
    // A late result from the finished recognition is not heard by the new one.
    expect(m.on(heard('First message.', true))).toEqual([]);
    expect(m.state.heard.text).toBe('');
  });

  it('tap sends the words now', () => {
    const m = listening();
    m.on(heard('stop the server'));
    expect(m.on({ type: 'tap' })).toEqual([{ type: 'stopListening' }]);
    expect(sends(m.on({ type: 'micEnded' }))).toEqual([{ type: 'send', text: 'Stop the server' }]);
  });

  it('says a plain line when a message did not reach the computer', () => {
    const m = listening();
    expect(m.on({ type: 'notSent' })).toEqual([{ type: 'stopListening' }]);
    expect(m.on({ type: 'micEnded' })).toEqual([
      { type: 'say', id: expect.any(Number), text: VOICE_LINES.notSent },
    ]);
  });
});

describe('speaking the reply', () => {
  it('stops listening and waits for the microphone to end before speaking', () => {
    const m = listening();
    expect(m.on({ type: 'reply', lines: ['One.', 'Two.'] })).toEqual([{ type: 'stopListening' }]);
    // Words heard while the microphone winds down are not taken.
    expect(m.on(heard('stray noise'))).toEqual([]);
    const first = m.on({ type: 'micEnded' });
    expect(first).toEqual([{ type: 'say', id: expect.any(Number), text: 'One.' }]);
    const second = finishSaying(m, first);
    expect(second).toEqual([{ type: 'say', id: expect.any(Number), text: 'Two.' }]);
    expect(sayId(second)).not.toBe(sayId(first));
    expect(finishSaying(m, second)).toEqual([{ type: 'listen' }]);
  });

  it('never listens while it is speaking', () => {
    const m = listening();
    m.on({ type: 'reply', lines: ['One.'] });
    const spoken = m.on({ type: 'micEnded' });
    for (const event of [
      { type: 'reply', lines: ['Two.'] },
      { type: 'micEnded' },
      { type: 'micStarted' },
      heard('hello there'),
      { type: 'tick' },
      { type: 'decision', decision: permission },
    ] satisfies VoiceEvent[])
      expect(m.on(event, 99_999).filter((effect) => effect.type === 'listen')).toEqual([]);
    expect(m.state.saying?.id).toBe(sayId(spoken));
  });

  it('waits for the user to finish before speaking over them', () => {
    const m = listening();
    m.on(heard('and also'));
    expect(m.on({ type: 'reply', lines: ['Reply.'] })).toEqual([]);
    expect(commitWords(m, 'And also this.')).toEqual([
      { type: 'send', text: 'And also this.' },
      { type: 'say', id: expect.any(Number), text: 'Reply.' },
    ]);
  });

  it('waits for a starting recognition before stopping it to speak', () => {
    const m = machine();
    m.on({ type: 'resume' });
    expect(m.on({ type: 'reply', lines: ['Hi.'] })).toEqual([]);
    expect(m.on({ type: 'micStarted' })).toEqual([{ type: 'stopListening' }]);
  });

  it('tap stops speaking, drops the rest and listens', () => {
    const m = listening();
    m.on({ type: 'reply', lines: ['One.', 'Two.'] });
    const spoken = m.on({ type: 'micEnded' });
    expect(m.on({ type: 'tap' })).toEqual([{ type: 'hush' }, { type: 'listen' }]);
    // The stopped line's own callback arrives late and is ignored.
    expect(finishSaying(m, spoken)).toEqual([]);
    expect(m.state.queue).toEqual([]);
  });

  it('tap stops the reply but still asks a request queued behind it', () => {
    const m = listening();
    m.on({ type: 'reply', lines: ['One.', 'Two.'] });
    m.on({ type: 'decision', decision: permission });
    m.on({ type: 'micEnded' });
    expect(m.on({ type: 'tap' })).toEqual([
      { type: 'hush' },
      { type: 'say', id: expect.any(Number), text: permission.line },
    ]);
  });

  it('pauses when a line could not be spoken, and ignores a stale failure', () => {
    const m = listening();
    m.on({ type: 'reply', lines: ['One.'] });
    const id = sayId(m.on({ type: 'micEnded' }));
    expect(m.on({ type: 'sayFailed', id: id + 1 })).toEqual([]);
    expect(m.on({ type: 'sayFailed', id })).toEqual([{ type: 'hush' }]);
    expect(m.state).toMatchObject({ paused: true, notice: VOICE_NOTICES.speech, saying: null });
  });

  it('keeps a reply that arrives while paused, and says it on resume', () => {
    const m = listening();
    m.on({ type: 'reply', lines: ['One.', 'Two.'] });
    m.on({ type: 'micEnded' });
    m.on({ type: 'pause', notice: VOICE_NOTICES.paused });
    expect(m.on({ type: 'reply', lines: ['Done.'] })).toEqual([]);
    const lines = (effects: VoiceEffect[]) =>
      effects.flatMap((effect) => (effect.type === 'say' ? [effect.text] : []));
    const resumed = m.on({ type: 'resume' });
    expect(lines(resumed)).toEqual(['One.']);
    expect(lines(finishSaying(m, resumed))).toEqual(['Two.']);
    expect(m.state.queue.map((line) => line.text)).toEqual(['Done.']);
  });
});

describe('answering a permission by voice', () => {
  it('reads the request, then a final "allow" sends exactly one approval', () => {
    const effects = answer('Allow.');
    expect(answers(effects)).toEqual([
      {
        type: 'answer',
        answer: { kind: 'permission', id: 'p1', approved: true },
        decision: permission.id,
      },
    ]);
    expect(effects).toContainEqual({
      type: 'say',
      id: expect.any(Number),
      text: VOICE_LINES.allowed,
    });
  });

  it('answers once even if allow is said again', () => {
    const m = asked();
    m.on(heard('allow'));
    expect(answers(commitWords(m, 'allow'))).toHaveLength(1);
    const spoken = m.state.saying;
    if (spoken) m.on({ type: 'said', id: spoken.id });
    m.on({ type: 'micStarted' });
    m.on(heard('allow'));
    expect(answers(commitWords(m, 'allow', 20_000))).toEqual([]);
  });

  it('denies only on an exact deny phrase', () => {
    expect(answers(answer('No'))).toEqual([
      {
        type: 'answer',
        answer: { kind: 'permission', id: 'p1', approved: false },
        decision: permission.id,
      },
    ]);
    expect(answers(answer("Don't allow."))).toHaveLength(1);
  });

  it.each([
    'yes I think so',
    "no don't allow that yet, yes",
    'allow everything',
    'yesterday',
    'I said yes',
    'allow allow',
  ])('"%s" changes nothing and says to answer on screen', (transcript) => {
    const effects = answer(transcript);
    expect(answers(effects)).toEqual([]);
    expect(effects).toContainEqual({ type: 'say', id: expect.any(Number), text: ON_SCREEN });
  });

  it('never approves on a partial result', () => {
    const m = asked();
    m.on(heard('allow'));
    expect(m.on({ type: 'tick' }, 10_000)).toEqual([{ type: 'stopListening' }]);
    // The recognizer never confirms the words before its end.
    expect(answers(m.on({ type: 'micEnded' }))).toEqual([]);
  });

  it('never approves before the request was read out in full', () => {
    const m = listening();
    m.on({ type: 'decision', decision: permission });
    m.on({ type: 'micEnded' });
    // A tap cuts the request short, so the next "allow" isn't an answer to it.
    m.on({ type: 'tap' });
    m.on({ type: 'micStarted' });
    m.on(heard('yes'));
    const effects = commitWords(m, 'yes');
    expect(answers(effects)).toEqual([]);
    // Instead the request is read again, and then an answer counts.
    expect(effects).toContainEqual({ type: 'say', id: expect.any(Number), text: permission.line });
    expect(finishSaying(m, effects)).toEqual([{ type: 'listen' }]);
    m.on({ type: 'micStarted' });
    m.on(heard('allow'));
    expect(answers(commitWords(m, 'allow', 20_000))).toHaveLength(1);
  });

  it('re-asks when the open request changes, and answers only the new one', () => {
    const m = asked();
    const next: Decision = {
      ...permission,
      id: 'permission:p2',
      ask: { kind: 'permission', id: 'p2' },
    };
    m.on(heard('allow'));
    m.on({ type: 'decision', decision: next });
    const ended = commitWords(m, 'allow');
    expect(answers(ended)).toEqual([]);
    expect(m.state.saying?.line).toEqual({ text: next.line, asks: next.id });
    finishSaying(m, ended);
    expect(m.state.asked).toBe(next.id);
    const onScreen = m.state.saying;
    if (onScreen) m.on({ type: 'said', id: onScreen.id });
    m.on({ type: 'micStarted' });
    m.on(heard('allow'));
    expect(answers(commitWords(m, 'Allow', 20_000))).toEqual([
      {
        type: 'answer',
        answer: { kind: 'permission', id: 'p2', approved: true },
        decision: 'permission:p2',
      },
    ]);
  });

  it('a request the phone may not answer is never answered by voice', () => {
    const onComputer: Decision = {
      id: 'permission:p3',
      line: 'Answer it on your computer.',
      ask: null,
    };
    expect(answers(answer('allow', onComputer))).toEqual([]);
  });

  it('a failed answer can be given again', () => {
    const m = asked();
    m.on(heard('allow'));
    commitWords(m, 'allow');
    m.on({ type: 'answerFailed', decision: 'permission:p2' });
    expect(m.state.answered).toBe(permission.id);
    m.on({ type: 'answerFailed', decision: permission.id });
    expect(m.state.answered).toBeNull();
    expect(m.state.queue.map((line) => line.text)).toContain(VOICE_LINES.answerFailed);
  });

  it('a question is answered by an option number or label', () => {
    const question: Decision = {
      id: 'question:q1',
      line: 'Frink asks: which database? 1: Postgres. 2: SQLite. Say a number.',
      ask: {
        kind: 'question',
        id: 'q1',
        question: 'Which database?',
        options: ['Postgres', 'SQLite'],
      },
    };
    const chosen = { kind: 'question', id: 'q1', question: 'Which database?', label: 'SQLite' };
    expect(answers(answer('Two.', question))).toEqual([
      { type: 'answer', answer: chosen, decision: question.id },
    ]);
    expect(answers(answer('option 2', question))).toEqual([
      { type: 'answer', answer: chosen, decision: question.id },
    ]);
    expect(answers(answer('SQLite', question))).toEqual([
      { type: 'answer', answer: chosen, decision: question.id },
    ]);
    expect(answers(answer('the second one', question))).toEqual([]);
  });

  it('sends words begun before a decision opened as a message, then asks it', () => {
    const m = listening();
    m.on(heard('please also run the'));
    m.on({ type: 'decision', decision: permission });
    expect(voiceControl(m.state)).toBe('send');
    expect(m.on({ type: 'tap' })).toEqual([{ type: 'stopListening' }]);
    m.on(heard('Please also run the tests.', true));
    expect(m.on({ type: 'micEnded' })).toEqual([
      { type: 'send', text: 'Please also run the tests.' },
      { type: 'say', id: expect.any(Number), text: permission.line },
    ]);
  });

  it('drops words begun for a decision that has since closed', () => {
    const m = asked();
    m.on(heard('allow'));
    m.on({ type: 'decision', decision: null });
    expect(commitWords(m, 'Allow.')).toEqual([{ type: 'listen' }]);
  });

  it('stays quiet about noise while a decision is open', () => {
    expect(answer('uh')).toEqual([{ type: 'listen' }]);
  });

  it('does not send words as a message while a decision is open', () => {
    const m = asked();
    m.on(heard('please run the migration'));
    const effects = commitWords(m, 'Please run the migration.');
    expect(sends(effects)).toEqual([]);
    expect(answers(effects)).toEqual([]);
  });
});

describe('every state has a way out', () => {
  it('pausing stops the microphone and speech, and resuming re-asks the open request', () => {
    const m = listening();
    m.on({ type: 'decision', decision: permission });
    m.on({ type: 'micEnded' });
    expect(m.on({ type: 'pause', notice: VOICE_NOTICES.paused })).toEqual([{ type: 'hush' }]);
    expect(m.state).toMatchObject({ paused: true, saying: null, queue: [], asked: null });
    expect(m.on({ type: 'resume' })).toEqual([
      { type: 'say', id: expect.any(Number), text: permission.line },
    ]);
  });

  it('pausing while listening aborts the recognition', () => {
    const m = listening();
    m.on(heard('half a'));
    expect(m.on({ type: 'pause', notice: null })).toEqual([{ type: 'abortListening' }]);
    expect(m.state.heard.text).toBe('');
    expect(m.on({ type: 'micEnded' })).toEqual([]);
  });

  it('tap with nothing heard pauses', () => {
    const m = listening();
    expect(m.on({ type: 'tap' })).toEqual([{ type: 'abortListening' }]);
    expect(m.state).toMatchObject({ paused: true, notice: VOICE_NOTICES.paused });
    expect(m.on({ type: 'tap' })).toEqual([]);
  });

  it('a tap while words are being finished waits for them', () => {
    const m = listening();
    m.on(heard('almost done'));
    m.on({ type: 'tap' });
    expect(m.on({ type: 'tap' })).toEqual([]);
    expect(m.state.paused).toBe(false);
  });

  it('a refused microphone pauses with a plain notice', () => {
    const m = listening();
    expect(m.on({ type: 'micError', code: 'not-allowed' })).toEqual([{ type: 'abortListening' }]);
    expect(m.state).toMatchObject({ paused: true, notice: VOICE_NOTICES.denied });
  });

  it('any other failure pauses too', () => {
    const m = listening();
    m.on({ type: 'micError', code: 'interrupted' });
    expect(m.state).toMatchObject({ paused: true, notice: VOICE_NOTICES.stopped });
  });

  it('a recognition that heard nothing ends and listening starts again', () => {
    const m = listening();
    expect(m.on({ type: 'micError', code: 'no-speech' })).toEqual([]);
    expect(m.on({ type: 'micEnded' })).toEqual([{ type: 'listen' }]);
  });

  it('stops after recognitions keep ending on their own', () => {
    const m = listening();
    for (let restart = 0; restart < 3; restart++) {
      // An empty result is not words, so it does not count as the microphone working.
      m.on(heard('', true));
      expect(m.on({ type: 'micEnded' })).toEqual([{ type: 'listen' }]);
      m.on({ type: 'micStarted' });
    }
    expect(m.on({ type: 'micError', code: 'no-speech' })).toEqual([{ type: 'abortListening' }]);
    expect(m.state).toMatchObject({ paused: true, notice: VOICE_NOTICES.stopped });
  });

  it('gives up a recognition that never starts', () => {
    const m = machine();
    m.on({ type: 'resume' }, 0);
    expect(deadline(m.state)).toBe(START_MS);
    expect(m.on({ type: 'tick' }, START_MS)).toEqual([{ type: 'abortListening' }]);
    expect(m.state).toMatchObject({ paused: true, notice: VOICE_NOTICES.stopped });
  });

  it('cuts off a recognition that never reports its end, keeping its words', () => {
    const m = listening();
    m.on(heard('ship it now'), 0);
    m.on({ type: 'tick' }, COMMIT_MS);
    expect(deadline(m.state)).toBe(COMMIT_MS + STOP_MS);
    expect(m.on({ type: 'tick' }, COMMIT_MS + STOP_MS)).toEqual([
      { type: 'abortListening' },
      { type: 'send', text: 'Ship it now' },
      { type: 'listen' },
    ]);
  });

  it('ignores events that do not fit the moment', () => {
    const m = machine();
    expect(m.on({ type: 'micStarted' })).toEqual([]);
    expect(m.on({ type: 'micEnded' })).toEqual([]);
    expect(m.on(heard('hello'))).toEqual([]);
    expect(m.on({ type: 'said', id: 7 })).toEqual([]);
    expect(m.on({ type: 'tick' })).toEqual([]);
    expect(m.state).toEqual({ ...PAUSED, notice: null });
    const live = listening();
    expect(live.on({ type: 'resume' })).toEqual([]);
    expect(live.on({ type: 'decision', decision: null })).toEqual([]);
  });
});

it('the big button names what a tap does', () => {
  const m = machine();
  expect(voiceControl(m.state)).toBe('resume');
  m.on({ type: 'resume' });
  m.on({ type: 'micStarted' });
  expect(voiceControl(m.state)).toBe('pause');
  m.on(heard('words'));
  expect(voiceControl(m.state)).toBe('send');
  m.on({ type: 'tap' });
  expect(voiceControl(m.state)).toBe('wait');
  m.on({ type: 'reply', lines: ['Reply.'] });
  expect(voiceControl(m.state)).toBe('wait');
  m.on(heard('Words.', true));
  m.on({ type: 'micEnded' });
  expect(voiceControl(m.state)).toBe('interrupt');
});

it('the status says what voice mode is doing', () => {
  const m = machine();
  expect(voiceStatus(m.state, true)).toBe('Paused');
  m.on({ type: 'resume' });
  expect(voiceStatus(m.state, false)).toBe('Listening');
  expect(voiceStatus(m.state, true)).toBe('Frink is working. Talk to guide it.');
  m.on({ type: 'reply', lines: ['Hi.'] });
  m.on({ type: 'micStarted' });
  m.on({ type: 'micEnded' });
  expect(voiceStatus(m.state, true)).toBe('Speaking');
});
