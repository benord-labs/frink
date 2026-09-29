import { describe, expect, it } from 'vitest';
import { formatPromptWithHistory } from './prompt-history';

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
