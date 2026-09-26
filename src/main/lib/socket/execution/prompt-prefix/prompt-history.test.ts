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
});
