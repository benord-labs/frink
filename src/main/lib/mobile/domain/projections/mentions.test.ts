import { describe, expect, it } from 'vitest';
import { encodeForMentionToken } from '../../../../../shared/lib/mentions/mention-token-codec';
import { projectMentions } from './mentions';

const SELECTED = 'export function secretSelection() {\n  return 42;\n}';
const PAYLOAD = encodeForMentionToken(SELECTED);

const chip = (name: string) => ({ type: 'attachment', kind: 'file', name });
const text = (value: string) => ({ type: 'text', text: value });

describe('projectMentions', () => {
  it.each([
    ['a picked file', '@[file:local:src/components/Button.tsx] tidy it', 'Button.tsx tidy it'],
    [
      'the open editor file',
      '@[file:editor:.oxlintrc.json] how are you?',
      '.oxlintrc.json how are you?',
    ],
    ['a folder', 'list @[folder:local:src/lib] please', 'list lib please'],
    ['a skill', 'use @[skill:frink-flows] here', 'use frink-flows here'],
    ['an agent', 'ask @[agent:reviewer] first', 'ask reviewer first'],
    ['a tool', 'call @[tool:mcp__figma__get_design] now', 'call Get Design now'],
  ])('names %s inline, as the desktop does', (_kind, body, expected) => {
    expect(projectMentions(body)).toEqual([text(expected)]);
  });

  it.each([
    [
      'a code selection',
      `@[code:Button.tsx:13-26:export function:${PAYLOAD}] why?`,
      'Button.tsx L13-26',
    ],
    [
      'a diff selection on a line',
      `@[diff:src/a.ts:12:export function:${PAYLOAD}] why?`,
      'a.ts:12',
    ],
    ['a diff selection on no line', `@[diff:src/a.ts:0:export function:${PAYLOAD}] why?`, 'a.ts'],
    ['a quote', `@[quote:export function secret:${PAYLOAD}] why?`, 'export function secret'],
    ['a pasted file', '@[pasted:120:notes.pdf|/p/abc-notes.pdf] why?', 'notes.pdf'],
    ['a pasted file with no name', '@[pasted:120:|/p/abc] why?', 'Attachment'],
    [
      'a Flow briefing',
      `@[briefing:flow-1:${encodeForMentionToken('Spec')}:${PAYLOAD}] why?`,
      'Spec',
    ],
  ])('shows %s as an attachment chip', (_kind, body, name) => {
    expect(projectMentions(body)).toEqual([chip(name), text('why?')]);
  });

  it('shows every kind a message can carry with no token or base64 left', () => {
    const body = [
      '@[file:editor:src/main.ts]',
      '@[file:local:src/app.ts]',
      `@[code:main.ts:1-3:export function:${PAYLOAD}]`,
      `@[quote:export function secret:${PAYLOAD}]`,
      'what changed?',
    ].join(' ');

    const parts = projectMentions(body);

    expect(parts).toEqual([
      chip('main.ts L1-3'),
      chip('export function secret'),
      text('main.ts app.ts what changed?'),
    ]);
    const shown = JSON.stringify(parts);
    expect(shown).not.toContain('@[');
    expect(shown).not.toContain(PAYLOAD);
    expect(shown).not.toContain('secretSelection');
  });

  it('degrades a malformed token of a known kind to a readable name, never to nothing', () => {
    expect(projectMentions('see @[diff:x] and @[file:notes.md]')).toEqual([
      chip('Attachment'),
      text('see and notes.md'),
    ]);
  });

  it('leaves a token of unknown kind as the user wrote it', () => {
    expect(projectMentions('remember @[TODO later] tomorrow')).toEqual([
      text('remember @[TODO later] tomorrow'),
    ]);
  });

  it('takes one space with a lifted token and keeps the indentation of what follows', () => {
    const body = `Look\n  @[quote:p:${PAYLOAD}] indented\n    code`;

    expect(projectMentions(body)).toEqual([chip('p'), text('Look\n  indented\n    code')]);
  });

  it('returns only chips when the message is nothing but attachments', () => {
    expect(projectMentions('@[pasted:1:a.txt|/p/a.txt]')).toEqual([chip('a.txt')]);
  });
});
