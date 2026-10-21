import { describe, expect, it } from 'vitest';
import {
  carriesHistory,
  formatPromptWithHistory,
  keepsCommandFirst,
  replaceCarriedWithHistory,
} from './prompt-history';

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

  it('returns a slash command bare so it stays at prompt position 0', () => {
    expect(formatPromptWithHistory('/compact', history)).toBe('/compact');
    expect(formatPromptWithHistory('/compact keep the API decisions', history)).toBe(
      '/compact keep the API decisions',
    );
    expect(formatPromptWithHistory('/review', history)).toBe('/review');
    expect(formatPromptWithHistory('/my-skill src/a.ts', history)).toBe('/my-skill src/a.ts');
  });

  it('wraps any command but /compact where the runtime runs no typed commands', () => {
    expect(formatPromptWithHistory('/review', history, false)).toContain('<conversation_history>');
    expect(formatPromptWithHistory('/compact', history, false)).toBe('/compact');
  });

  it('still wraps a prompt that only mentions a command or starts with a path', () => {
    expect(formatPromptWithHistory('please run /compact', history)).toContain(
      '<conversation_history>',
    );
    expect(formatPromptWithHistory('/src/a.ts is broken', history)).toContain(
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

  it('recaps a steer replayed as the person’s turn between two assistant turns', () => {
    const preview = Buffer.from('const a = 1;').toString('base64');
    const out = formatPromptWithHistory('next', [
      { role: 'assistant', content: 'working on @[file:local:b.ts]' },
      {
        role: 'user',
        content: `look at @[code:a.ts:3-4:preview:${preview}] then @[skill:deploy]`,
        personAuthored: true,
      },
      { role: 'assistant', content: 'switching' },
    ]);
    expect(out).toContain(
      'Assistant: working on @[file:local:b.ts]\n\nHuman: look at [selected lines 3-4 of a.ts:\nconst a = 1;] then [skill deploy]\n\nAssistant: switching',
    );
    expect(out).not.toContain(preview);
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
  const fresh = formatPromptWithHistory('do the thing', history);

  it('puts the fresh prompt in place of what a resume would have carried', () => {
    const out = replaceCarriedWithHistory(`a prefix\n\n${carried}`, carried, fresh, history);
    expect(out.startsWith('a prefix\n\n<conversation_history>')).toBe(true);
    expect(out).not.toContain('a note and an earlier message');
    expect(out.endsWith('do the thing')).toBe(true);
  });

  it('keeps a slash command bare in place of what a resume would have carried', () => {
    expect(replaceCarriedWithHistory('/review', '/review', '/review', history)).toBe('/review');
  });

  it('keeps the prompt whole when there is no transcript to seed from', () => {
    expect(replaceCarriedWithHistory(carried, carried, 'do the thing', [])).toBe(carried);
    expect(replaceCarriedWithHistory(carried, carried, 'do the thing', undefined)).toBe(carried);
  });
});

describe('carriesHistory', () => {
  it('is true only for a message that is not a command, with a transcript to carry', () => {
    expect(carriesHistory('do the thing', history)).toBe(true);
    expect(carriesHistory('do the thing', [])).toBe(false);
    expect(carriesHistory('do the thing', undefined)).toBe(false);
    expect(carriesHistory('/review', history)).toBe(false);
    expect(carriesHistory('/review', history, false)).toBe(true);
  });
});

describe('keepsCommandFirst', () => {
  it('keeps /compact first everywhere and other commands only where typed commands run', () => {
    expect(keepsCommandFirst('/compact', false)).toBe(true);
    expect(keepsCommandFirst('/review', true)).toBe(true);
    expect(keepsCommandFirst('/review', false)).toBe(false);
    expect(keepsCommandFirst('/src/a.ts is broken', true)).toBe(false);
  });
});
