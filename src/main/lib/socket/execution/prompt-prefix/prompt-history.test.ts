import { describe, expect, it } from 'vitest';
import { formatPromptWithHistory, replaceCarriedWithHistory } from './prompt-history';

const history = [
  { role: 'user' as const, content: 'earlier question' },
  { role: 'assistant' as const, content: 'earlier answer' },
];

describe('formatPromptWithHistory', () => {
  it('wraps a normal prompt in the transcript', () => {
    const out = formatPromptWithHistory('do the thing', history);
    expect(out).toContain('<conversation_history>');
    expect(out).toContain('earlier question');
    expect(out.endsWith('do the thing')).toBe(true);
  });

  it('returns /compact bare so it stays at prompt position 0', () => {
    // The transcript wrapper would push the command off position 0 and the provider would never
    // dispatch it — and the history it carries is what compaction is about to discard anyway.
    expect(formatPromptWithHistory('/compact', history)).toBe('/compact');
    expect(formatPromptWithHistory('/compact keep the API decisions', history)).toBe(
      '/compact keep the API decisions',
    );
  });

  it('still wraps a prompt that only mentions the command', () => {
    expect(formatPromptWithHistory('please run /compact', history)).toContain(
      '<conversation_history>',
    );
  });

  it('recaps the tokens of a person’s turns and replays every other turn as stored', () => {
    const selection = `@[quote:p:${Buffer.from('x'.repeat(5000)).toString('base64')}]`;
    const out = formatPromptWithHistory('next', [
      { role: 'user', content: `${selection} why @[file:local:a.ts]?`, personAuthored: true },
      { role: 'assistant', content: 'see @[file:local:b.ts]' },
      { role: 'user', content: 'Flow step: read @[file:local:c.ts]' },
    ]);
    expect(out).toContain(
      `Human: [quoted an earlier message:\n${'x'.repeat(2000)}\n... (truncated)] why a.ts?`,
    );
    expect(out).not.toContain(selection);
    expect(out).toContain('Assistant: see @[file:local:b.ts]');
    expect(out).toContain('Human: Flow step: read @[file:local:c.ts]');
  });

  it('recaps before the budget cut, so a large selection cannot push out earlier turns', () => {
    const selection = `@[quote:p:${Buffer.from('x'.repeat(300_000)).toString('base64')}]`;
    const out = formatPromptWithHistory('next', [
      { role: 'user', content: 'the first question' },
      { role: 'user', content: `${selection} explain`, personAuthored: true },
    ]);
    expect(out).toContain('Human: the first question');
    expect(out).not.toContain('Earlier conversation omitted');
  });

  it('returns the prompt unchanged when there is no history', () => {
    expect(formatPromptWithHistory('do the thing', [])).toBe('do the thing');
    expect(formatPromptWithHistory('do the thing', undefined)).toBe('do the thing');
  });

  it('keeps the newest history within budget and marks what it dropped', () => {
    const long = Array.from({ length: 300 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${i} ${'x'.repeat(1000)}`,
    }));

    const out = formatPromptWithHistory('latest ask', long);

    expect(out.length).toBeLessThan(200_000 + 500);
    expect(out).toMatch(
      /\[Earlier conversation omitted to fit the context budget: \d+ characters\]/,
    );
    expect(out).toContain('Assistant: message 299');
    expect(out).not.toContain('message 0 ');
    expect(out.endsWith('latest ask')).toBe(true);
    // The cut lands on a message boundary, so the first kept turn is whole.
    expect(out).toMatch(/characters\]\n\n(Human|Assistant): message \d+ /);
  });

  it('keeps the tail of a single message larger than the budget', () => {
    const out = formatPromptWithHistory('go', [
      { role: 'user', content: `${'a'.repeat(300_000)}END` },
    ]);

    expect(out.length).toBeLessThan(200_000 + 500);
    expect(out).toContain('aEND');
    expect(out).toContain('Earlier conversation omitted');
  });
});

describe('replaceCarriedWithHistory', () => {
  const carried = 'a note and an earlier message\n\ndo the thing';

  it('puts the transcript in place of what a resume would have carried', () => {
    const out = replaceCarriedWithHistory(
      `a prefix\n\n${carried}`,
      carried,
      'do the thing',
      history,
    );
    expect(out.startsWith('a prefix\n\n<conversation_history>')).toBe(true);
    expect(out).not.toContain('a note and an earlier message');
    expect(out.endsWith('do the thing')).toBe(true);
  });

  it('keeps the prompt whole when there is no transcript to seed from', () => {
    expect(replaceCarriedWithHistory(carried, carried, 'do the thing', [])).toBe(carried);
    expect(replaceCarriedWithHistory(carried, carried, 'do the thing', undefined)).toBe(carried);
  });
});
