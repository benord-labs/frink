import { describe, expect, it } from 'vitest';
import { extractTrailingUsageLimitText, isUsageLimitText } from './usage-limit';

const LIMIT_TEXT = "You've hit your limit · resets 2:20pm (Europe/London)";

describe('isUsageLimitText', () => {
  it.each([
    ['chat-surface limit message', LIMIT_TEXT],
    ['SDK error-result wrapper', `Claude Code returned an error result: ${LIMIT_TEXT}`],
    ['usage limit reached (legacy CLI shape)', 'Claude AI usage limit reached|1718000000'],
    ['claude code usage limit toast copy', "You've hit the Claude Code usage limit."],
    ['timed-window variant (limit reached + resets)', '5-hour limit reached ∙ resets 3am'],
    ['typographic apostrophe (U+2019)', 'You’ve hit your limit · resets 2:20pm (Europe/London)'],
  ])('matches %s', (_label, text) => {
    expect(isUsageLimitText(text)).toBe(true);
  });

  it.each([
    ['generic rate limit', 'rate limit exceeded'],
    ['resume failure', 'Session not found'],
    ['empty string', ''],
  ])('rejects %s', (_label, text) => {
    expect(isUsageLimitText(text)).toBe(false);
  });

  it('rejects long prose that quotes a limit phrase (length guard)', () => {
    const prose = `${'Summary of the work performed. '.repeat(20)}The toast says "usage limit reached" when the quota is exhausted.`;
    expect(prose.length).toBeGreaterThan(300);
    expect(isUsageLimitText(prose)).toBe(false);
  });
});

describe('extractTrailingUsageLimitText', () => {
  it.each([
    [
      'limit text as the final text part',
      [
        { type: 'text', text: 'Working on the fix…' },
        { type: 'text', text: LIMIT_TEXT },
      ],
      LIMIT_TEXT,
    ],
    [
      'trailing step-start and reasoning parts skipped',
      [
        { type: 'text', text: LIMIT_TEXT },
        { type: 'reasoning', text: 'thinking' },
        { type: 'step-start' },
      ],
      LIMIT_TEXT,
    ],
    [
      'timed-window variant',
      [{ type: 'text', text: '5-hour limit reached ∙ resets 3am' }],
      '5-hour limit reached ∙ resets 3am',
    ],
    [
      'typographic apostrophe (U+2019)',
      [{ type: 'text', text: 'You’ve hit your limit · resets 2:20pm (Europe/London)' }],
      'You’ve hit your limit · resets 2:20pm (Europe/London)',
    ],
    [
      'limit phrase only in an EARLIER part',
      [
        { type: 'text', text: LIMIT_TEXT },
        { type: 'text', text: 'Continuing after the quoted message above.' },
      ],
      null,
    ],
    [
      'final part is a tool part',
      [
        { type: 'text', text: LIMIT_TEXT },
        { type: 'tool-Bash', text: undefined },
      ],
      null,
    ],
    [
      // Consecutive text deltas merge into one part — a mid-sentence quote must not match.
      'final part merely QUOTES the limit phrase mid-sentence',
      [{ type: 'text', text: `The toast text is "${LIMIT_TEXT}". Continuing now.` }],
      null,
    ],
    ['normal completion', [{ type: 'text', text: 'All done!' }], null],
    ['empty parts', [], null],
  ])('%s', (_label, parts, expected) => {
    expect(extractTrailingUsageLimitText(parts)).toBe(expected);
  });
});
