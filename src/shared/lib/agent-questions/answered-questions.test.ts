import { describe, expect, it } from 'vitest';
import {
  type AnsweredQuestion,
  buildAnswerMessage,
  readAnsweredQuestions,
  toAnsweredQuestions,
} from './answered-questions';

const q = (question: string, header: string) => ({ question, header });

describe('toAnsweredQuestions', () => {
  it('pairs each question with its answer, labelled by header', () => {
    expect(toAnsweredQuestions([q('a', 'Path'), q('b', 'Scope')], { a: 'Now', b: 'Wide' })).toEqual(
      [
        { label: 'Path', answer: 'Now' },
        { label: 'Scope', answer: 'Wide' },
      ],
    );
  });

  it('drops questions left unanswered or answered with whitespace only', () => {
    expect(toAnsweredQuestions([q('a', 'Path'), q('b', 'Scope')], { a: 'Now', b: '  ' })).toEqual([
      { label: 'Path', answer: 'Now' },
    ]);
  });

  it('trims the answer', () => {
    expect(toAnsweredQuestions([q('a', 'Path')], { a: '  Now  ' })).toEqual([
      { label: 'Path', answer: 'Now' },
    ]);
  });
});

describe('buildAnswerMessage', () => {
  it('splits the model-visible text from the display-only pairs', () => {
    const built = buildAnswerMessage([q('a', 'Coverage gate'), q('b', 'Clone gate')], {
      a: 'Opt coverage out',
      b: 'Allowlist as pre-existing',
    });

    // The text is ALL the model receives — no marker, so nothing downstream has to strip anything.
    expect(built?.text).toBe('Q: a\nA: Opt coverage out\n\nQ: b\nA: Allowlist as pre-existing');
    expect(built?.text).not.toContain('<!--');
    expect(built?.metadata).toEqual({
      answeredQuestions: [
        { label: 'Coverage gate', answer: 'Opt coverage out' },
        { label: 'Clone gate', answer: 'Allowlist as pre-existing' },
      ],
    });
  });

  it('returns null when nothing was picked, so callers know not to send', () => {
    expect(buildAnswerMessage([q('a', 'Path')], { a: '   ' })).toBeNull();
    expect(buildAnswerMessage([], {})).toBeNull();
  });

  // Every answer lands in a LATER turn than its question, and a park ends the asking turn
  // unanswered — the CLI then discards it. A bare "Now" would reach the agent with nothing to
  // attach it to, so even a single question is restated.
  it('restates a lone question too, because the turn that asked it may be gone', () => {
    expect(buildAnswerMessage([q('a', 'Path')], { a: 'Now' })?.text).toBe('Q: a\nA: Now');
  });

  it('drops an unanswered question from the restated text, not just from the metadata', () => {
    const built = buildAnswerMessage([q('a', 'Path'), q('b', 'Scope')], { a: 'Now', b: '  ' });

    expect(built?.text).toBe('Q: a\nA: Now');
    expect(built?.metadata.answeredQuestions).toEqual([{ label: 'Path', answer: 'Now' }]);
  });
});

describe('readAnsweredQuestions', () => {
  it('accepts a well-formed payload off persisted metadata', () => {
    const answered: AnsweredQuestion[] = [{ label: 'Path', answer: 'Now' }];
    expect(readAnsweredQuestions(answered)).toEqual(answered);
  });

  it('rejects anything mis-shaped rather than rendering a broken card', () => {
    expect(readAnsweredQuestions(undefined)).toBeNull();
    expect(readAnsweredQuestions([])).toBeNull();
    expect(readAnsweredQuestions('nope')).toBeNull();
    expect(readAnsweredQuestions([{ label: 1, answer: 'x' }])).toBeNull();
    expect(readAnsweredQuestions([{ label: 'x' }])).toBeNull();
  });
});
