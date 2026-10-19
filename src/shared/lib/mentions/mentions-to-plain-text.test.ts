import { describe, expect, it } from 'vitest';
import { encodeForMentionToken } from './mention-token-codec';
import { mentionsToPlainText } from './mentions-to-plain-text';

const enc = encodeForMentionToken;

describe('mentionsToPlainText', () => {
  it.each([
    ['a picked file', '@[file:local:src/auth/login.ts]', 'login.ts'],
    ['a picked folder', '@[folder:local:src/components]', 'components'],
    ['a skill', '@[skill:frink-flows]', 'frink-flows'],
    ['an agent', '@[agent:Explore]', 'Explore'],
    ['a tool', '@[tool:mcp__figma__get_design]', 'Get Design'],
  ])('replaces %s with its label', (_kind, token, label) => {
    expect(mentionsToPlainText(`${token} fix the login bug`)).toStrictEqual({
      text: `${label} fix the login bug`,
      labels: [label],
    });
  });

  it.each([
    ['the open editor file', '@[file:editor:src/a.ts]', 'a.ts'],
    ['a quote', `@[quote:Use strict mode:${enc('Use strict mode everywhere')}]`, 'Use strict mode'],
    [
      'a diff selection',
      `@[diff:src/app.tsx:42:const a = 1;:${enc('const a = 1;')}]`,
      'app.tsx:42',
    ],
    ['a code selection', `@[code:a.ts:13-26:const x:${enc('const x = 1;\n')}]`, 'a.ts L13-26'],
    ['a paste', '@[pasted:120:ERROR boom|/tmp/pasted.txt]', 'ERROR boom'],
    ['a briefing', `@[briefing:flow1:${enc('Spec')}:${enc('Follow the spec.')}]`, 'Spec'],
  ])('removes %s from the text but keeps its label', (_kind, token, label) => {
    expect(mentionsToPlainText(`${token} fix the login bug`)).toStrictEqual({
      text: 'fix the login bug',
      labels: [label],
    });
  });

  it('removes a token it cannot parse, without a label', () => {
    expect(mentionsToPlainText('@[note] fix the login bug')).toStrictEqual({
      text: 'fix the login bug',
      labels: [],
    });
  });

  it('projects tokens anywhere in the message', () => {
    expect(
      mentionsToPlainText('rename @[file:local:src/a.ts] to match @[skill:naming] please'),
    ).toStrictEqual({ text: 'rename a.ts to match naming please', labels: ['a.ts', 'naming'] });
  });

  // The composer serializes an inline chip with no spaces around it.
  it('keeps the words either side of a removed token apart', () => {
    const code = `@[code:a.ts:13-26:const x:${enc('const x = 1;')}]`;
    expect(mentionsToPlainText(`please review${code}this file`).text).toBe(
      'please review this file',
    );
  });

  it('leaves only labels for a message made of tokens', () => {
    const code = `@[code:a.ts:13-26:const x:${enc('const x = 1;')}]`;
    expect(mentionsToPlainText(`@[file:editor:src/a.ts] ${code}`)).toStrictEqual({
      text: '',
      labels: ['a.ts', 'a.ts L13-26'],
    });
  });

  it('drops a large selection payload, keeping only the typed sentence', () => {
    const payload = enc('x'.repeat(5000));
    const { text } = mentionsToPlainText(`@[code:a.ts:1-200:x:${payload}] explain this`);
    expect(text).toBe('explain this');
    expect(text).not.toContain('@[');
  });

  it('returns plain text unchanged apart from whitespace', () => {
    expect(mentionsToPlainText('  fix   the bug ')).toStrictEqual({
      text: 'fix the bug',
      labels: [],
    });
  });
});
