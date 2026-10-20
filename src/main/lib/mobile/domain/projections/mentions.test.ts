import { describe, expect, it } from 'vitest';
import { encodeForMentionToken } from '../../../../../shared/lib/mentions/mention-token-codec';
import { projectMentions, projectMentionsAsText } from './mentions';

const SELECTED = 'export function secretSelection() {\n  return 42;\n}';
const PAYLOAD = encodeForMentionToken(SELECTED);

const chip = (name: string) => ({ type: 'attachment', kind: 'file', name });
const lines = (name: string, detail: string) => ({
  type: 'attachment',
  kind: 'file',
  name,
  detail,
});
const text = (value: string) => ({ type: 'text', text: value });

describe('projectMentions', () => {
  it.each([
    ['a picked file', '@[file:local:src/components/Button.tsx] tidy it', 'Button.tsx', 'file'],
    ['the open editor file', '@[file:editor:.oxlintrc.json] tidy it', '.oxlintrc.json', 'file'],
    ['a folder', '@[folder:local:src/lib] tidy it', 'lib', 'folder'],
    ['a skill', '@[skill:frink-flows] tidy it', 'frink-flows', 'skill'],
    ['an agent', '@[agent:reviewer] tidy it', 'reviewer', 'agent'],
    ['a tool', '@[tool:mcp__figma__get_design] tidy it', 'Get Design', 'tool'],
  ])(
    'draws %s as a badge inside the sentence, as the desktop does',
    (_kind, body, name, mention) => {
      expect(projectMentions(body)).toEqual([
        {
          type: 'text',
          text: `${name} tidy it`,
          runs: [{ text: name, mention }, { text: ' tidy it' }],
        },
      ]);
    },
  );

  it.each([
    [
      'a code selection, with its lines',
      `@[code:Button.tsx:13-26:export function:${PAYLOAD}] why?`,
      lines('Button.tsx', 'L13-26'),
    ],
    [
      'a diff selection, with its line',
      `@[diff:src/a.ts:12:export function:${PAYLOAD}] why?`,
      lines('a.ts', 'L12'),
    ],
    [
      'a diff selection on no line',
      `@[diff:src/a.ts:0:export function:${PAYLOAD}] why?`,
      chip('a.ts'),
    ],
    [
      'a quote, as selected words',
      `@[quote:export function secret:${PAYLOAD}] why?`,
      { type: 'attachment', kind: 'text', name: 'export function secret' },
    ],
    ['a pasted file', '@[pasted:120:notes.pdf|/p/abc-notes.pdf] why?', chip('notes.pdf')],
    ['a pasted file with no name', '@[pasted:120:|/p/abc] why?', chip('Attachment')],
    [
      'a Flow briefing',
      `@[briefing:flow-1:${encodeForMentionToken('Spec')}:${PAYLOAD}] why?`,
      chip('Spec'),
    ],
  ])('shows %s as an attachment chip', (_kind, body, attachment) => {
    expect(projectMentions(body)).toEqual([attachment, text('why?')]);
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
      lines('main.ts', 'L1-3'),
      { type: 'attachment', kind: 'text', name: 'export function secret' },
      {
        type: 'text',
        text: 'main.ts app.ts what changed?',
        runs: [
          { text: 'main.ts', mention: 'file' },
          { text: ' ' },
          { text: 'app.ts', mention: 'file' },
          { text: ' what changed?' },
        ],
      },
    ]);
    const shown = JSON.stringify(parts);
    expect(shown).not.toContain('@[');
    expect(shown).not.toContain(PAYLOAD);
    expect(shown).not.toContain('secretSelection');
  });

  it('degrades a malformed token of a known kind to a readable name, never to nothing', () => {
    expect(projectMentions('see @[diff:x] and @[file:notes.md]')).toEqual([
      chip('Attachment'),
      {
        type: 'text',
        text: 'see and notes.md',
        runs: [{ text: 'see and ' }, { text: 'notes.md', mention: 'file' }],
      },
    ]);
  });

  it('leaves a token of unknown kind as the user wrote it, with no badge runs', () => {
    expect(projectMentions('remember @[TODO later] tomorrow')).toEqual([
      text('remember @[TODO later] tomorrow'),
    ]);
  });

  it('takes one space with a lifted token and keeps the indentation of what follows', () => {
    const body = `Look\n  @[quote:p:${PAYLOAD}] indented\n    code`;

    expect(projectMentions(body)).toEqual([
      { type: 'attachment', kind: 'text', name: 'p' },
      text('Look\n  indented\n    code'),
    ]);
  });

  // The phone splits the bubble at the runs, so they must join to exactly the text it shows.
  it('trims the badge runs with the text, so they still join to it', () => {
    expect(projectMentions('  \n @[skill:foo] then  ')).toEqual([
      {
        type: 'text',
        text: 'foo then',
        runs: [{ text: 'foo', mention: 'skill' }, { text: ' then' }],
      },
    ]);
  });

  it('returns only chips when the message is nothing but attachments', () => {
    expect(projectMentions('@[pasted:1:a.txt|/p/a.txt]')).toEqual([chip('a.txt')]);
  });
});

describe('projectMentionsAsText', () => {
  it('keeps selections as words where they were typed, and names as badges', () => {
    expect(
      projectMentionsAsText(`use @[file:local:a.ts] like @[diff:src/b.ts:4:x:${PAYLOAD}] does`),
    ).toEqual({
      text: 'use a.ts like b.ts L4 does',
      runs: [{ text: 'use ' }, { text: 'a.ts', mention: 'file' }, { text: ' like b.ts L4 does' }],
    });
  });
});
