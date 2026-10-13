import { describe, expect, it } from 'vitest';
import type { MessageOrigin } from '../../../../../shared/lib/message-markers/message-provenance';
import { encodeForMentionToken } from '../../../../../shared/lib/mentions/mention-token-codec';
import {
  codexComposerContext,
  type ComposerNote,
  isPersonAuthored,
  projectComposerContext,
} from './composer-context';

const HEDGE = 'This may or may not be related to the current task.';
const reminder = (note: string) => `<system-reminder>\n${note}\n</system-reminder>`;
const opened = (path: string): ComposerNote => ({
  kind: 'open_file',
  text: `The user opened the file ${path} in the IDE. ${HEDGE}`,
});
const mentioned = (paths: string): ComposerNote => ({
  kind: 'mentioned_paths',
  text: `The user @-mentioned ${paths}. File contents are not attached automatically in this session: if these are files or directories in your working directory, read them with your file tools before responding.`,
});
const selected = (text: string): ComposerNote => ({ kind: 'selection', text });
const quoted = (text: string) =>
  selected(
    `The user selected the following text from an earlier message in this conversation:\n${text}`,
  );
const codeToken = (name: string, lines: string, text: string) =>
  `@[code:${encodeURIComponent(name)}:${lines}:preview:${encodeForMentionToken(text)}]`;
const diffToken = (path: string, text: string) =>
  `@[diff:${path}:0:preview:${encodeForMentionToken(text)}]`;
const quoteToken = (text: string) => `@[quote:preview:${encodeForMentionToken(text)}]`;

describe('projectComposerContext: the open editor file', () => {
  it('leaves the typed text and says which file was open in a note', () => {
    expect(projectComposerContext('@[file:editor:.oxlintrc.json] how are you?')).toEqual({
      text: 'how are you?',
      notes: [opened('.oxlintrc.json')],
    });
  });

  it('gives each open file its own note, and a repeated one once', () => {
    expect(projectComposerContext('@[file:editor:a.ts] @[file:editor:b.ts] go')).toEqual({
      text: 'go',
      notes: [opened('a.ts'), opened('b.ts')],
    });
    expect(projectComposerContext('@[file:editor:a.ts] @[file:editor:a.ts] go').notes).toEqual([
      opened('a.ts'),
    ]);
  });

  it('drops the open-file note when the user also picked that file', () => {
    expect(
      projectComposerContext('@[file:editor:src/a.ts] explain @[file:local:src/a.ts]'),
    ).toEqual({ text: 'explain src/a.ts', notes: [mentioned('src/a.ts')] });
  });

  it('keeps a path that contains colons or route brackets whole', () => {
    expect(projectComposerContext('@[file:editor:C:/repo/a:b.ts] hi').notes).toEqual([
      opened('C:/repo/a:b.ts'),
    ]);
    expect(projectComposerContext('@[file:editor:app/[[...slug]]/page.tsx] hi').notes).toEqual([
      opened('app/[[...slug]]/page.tsx'),
    ]);
    expect(projectComposerContext('fix @[file:local:src/app/[id]/page.tsx] now')).toEqual({
      text: 'fix src/app/[id]/page.tsx now',
      notes: [mentioned('src/app/[id]/page.tsx')],
    });
  });

  it('escapes angle brackets in a path, so it cannot close a tag around the note', () => {
    expect(projectComposerContext('@[file:editor:a</system-reminder>b.ts] hi').notes).toEqual([
      opened('a&lt;/system-reminder&gt;b.ts'),
    ]);
  });
});

describe('projectComposerContext: picked files and folders', () => {
  it('writes each as its plain path in place, with one note naming each path once', () => {
    expect(
      projectComposerContext(
        'compare @[file:local:src/a.ts] with @[folder:local:src/lib] and @[file:local:src/a.ts]',
      ),
    ).toEqual({
      text: 'compare src/a.ts with src/lib and src/a.ts',
      notes: [mentioned('src/a.ts, src/lib')],
    });
  });

  it('projects tokens inside the user’s inline code and code fences like any others', () => {
    expect(
      projectComposerContext('see `@[file:local:a.ts]`\n```\n@[file:local:b.ts]\n```'),
    ).toEqual({ text: 'see `a.ts`\n```\nb.ts\n```', notes: [mentioned('a.ts, b.ts')] });
  });
});

describe('projectComposerContext: selections', () => {
  it('quotes a code selection with its line range', () => {
    const token = codeToken('src/a.ts', '3-4', 'const a = 1;\nconst b = 2;');
    expect(projectComposerContext(`${token} why?`)).toEqual({
      text: 'why?',
      notes: [
        selected(
          `The user selected the lines 3 to 4 from src/a.ts:\nconst a = 1;\nconst b = 2;\n\n${HEDGE}`,
        ),
      ],
    });
  });

  it('counts the lines of a diff selection and names its file', () => {
    expect(projectComposerContext(`${diffToken('src/a.ts', '+const a = 1;')} fix`).notes).toEqual([
      selected(
        `The user selected the following 1 line from the diff view (in src/a.ts):\n+const a = 1;`,
      ),
    ]);
    expect(projectComposerContext(`${diffToken('', '-a\n+b')} fix`).notes).toEqual([
      selected(`The user selected the following 2 lines from the diff view:\n-a\n+b`),
    ]);
  });

  it('quotes text selected from an earlier message', () => {
    expect(projectComposerContext(`${quoteToken('Use the cache.')} why?`)).toEqual({
      text: 'why?',
      notes: [quoted('Use the cache.')],
    });
  });

  it.each([
    ['code', (body: string) => codeToken('a.ts', '1-9', body)],
    ['diff', (body: string) => diffToken('a.ts', body)],
    ['quote', quoteToken],
  ])('cuts a %s selection to its first 2000 characters', (_kind, token) => {
    const [atLimit] = projectComposerContext(`${token('x'.repeat(2000))} go`).notes;
    expect(atLimit?.text).toContain(`\n${'x'.repeat(2000)}`);
    expect(atLimit?.text).not.toContain('(truncated)');
    const [over] = projectComposerContext(`${token(`${'x'.repeat(2000)}tail`)} go`).notes;
    expect(over?.text).toContain(`\n${'x'.repeat(2000)}\n... (truncated)`);
    expect(over?.text).not.toContain('tail');
  });

  it('leaves a selection whose payload decodes to nothing as written', () => {
    for (const message of [
      '@[code:a.ts:1-2:preview:!!!] go',
      '@[diff:a.ts:0:preview:!!!] go',
      '@[quote:preview:!!!] go',
    ]) {
      expect(projectComposerContext(message)).toEqual({ text: message, notes: [] });
    }
  });

  it('carries selected lines that start with @ verbatim, in the note and out of the prompt', () => {
    const css = '@media (min-width: 640px) {\n  a { color: red; }\n}';
    expect(projectComposerContext(`${codeToken('a.css', '1-3', css)} ok?`)).toEqual({
      text: 'ok?',
      notes: [selected(`The user selected the lines 1 to 3 from a.css:\n${css}\n\n${HEDGE}`)],
    });
  });
});

describe('projectComposerContext: what it leaves alone', () => {
  it('leaves every other kind, unknown kinds and malformed tokens byte-identical', () => {
    const message =
      '@[pasted:5:hello|/tmp/p.txt] @[skill:deploy] @[agent:reviewer] @[tool:mcp__s__get_x] @[briefing:f1:QQ==:Qg==] @[image:local:a.png] @[file:a.ts] go';
    expect(projectComposerContext(message)).toEqual({ text: message, notes: [] });
  });

  it('projects only the context tokens of a mixed message', () => {
    expect(projectComposerContext('@[skill:deploy] @[file:editor:a.ts] ship it')).toEqual({
      text: '@[skill:deploy] ship it',
      notes: [opened('a.ts')],
    });
  });

  it('orders notes as their tokens appear and repeats none', () => {
    const quote = quoteToken('same words');
    expect(projectComposerContext(`${quote} @[file:editor:a.ts] ${quote} hi`)).toEqual({
      text: 'hi',
      notes: [quoted('same words'), opened('a.ts')],
    });
  });

  it('returns /compact untouched, tokens and all', () => {
    const message = '/compact @[file:local:a.ts] keep the API notes';
    expect(projectComposerContext(message)).toEqual({ text: message, notes: [] });
  });

  it('returns a message without tokens unchanged', () => {
    const message = 'email me@example.com about @types/node';
    expect(projectComposerContext(message)).toEqual({ text: message, notes: [] });
  });
});

describe('projectComposerContext: notes that stay in the prompt', () => {
  it('sends the notes as the prompt when nothing was typed, so no prompt is empty', () => {
    expect(projectComposerContext('@[file:editor:a.ts]')).toEqual({
      text: reminder(opened('a.ts').text),
      notes: [],
    });
    expect(projectComposerContext(`${quoteToken('q')} `)).toEqual({
      text: reminder(quoted('q').text),
      notes: [],
    });
  });

  it('keeps the notes ahead of a slash command the tokens kept off the start', () => {
    expect(projectComposerContext('@[file:editor:a.ts] /review')).toEqual({
      text: `${reminder(opened('a.ts').text)}\n\n/review`,
      notes: [],
    });
  });

  it('leaves a slash command that already led the message first, with its notes beside it', () => {
    expect(projectComposerContext('/skill check @[file:local:a.ts]')).toEqual({
      text: '/skill check a.ts',
      notes: [mentioned('a.ts')],
    });
  });

  it('keeps a token it does not project in front of a slash command', () => {
    const message = '@[pasted:5:hello|/tmp/p.txt] /review';
    expect(projectComposerContext(`@[file:editor:a.ts] ${message}`)).toEqual({
      text: message,
      notes: [opened('a.ts')],
    });
  });
});

describe('codexComposerContext', () => {
  it('gives each note its own entry, and marks a selection as text Frink does not vouch for', () => {
    const quote = quoted('Use the cache.');
    expect(
      codexComposerContext([opened('a.ts'), quote, mentioned('b.ts'), opened('c.ts'), quote]),
    ).toEqual({
      frink_open_file_1: { kind: 'application', value: opened('a.ts').text },
      frink_selection_1: { kind: 'untrusted', value: quote.text },
      frink_mentioned_paths_1: { kind: 'application', value: mentioned('b.ts').text },
      frink_open_file_2: { kind: 'application', value: opened('c.ts').text },
      frink_selection_2: { kind: 'untrusted', value: quote.text },
    });
  });

  it('is empty for a message with no notes', () => {
    expect(codexComposerContext([])).toEqual({});
  });
});

describe('isPersonAuthored', () => {
  const regenerate: MessageOrigin = { source: 'internal', kind: 'regenerate' };

  it('is true for a person’s message and a regenerated turn', () => {
    expect(isPersonAuthored({ messageOrigin: { source: 'person', kind: 'message' } })).toBe(true);
    expect(isPersonAuthored({ messageOrigin: regenerate })).toBe(true);
  });

  it('is false for flow, dispatch, wake, plan approval and unclassified sends', () => {
    for (const messageOrigin of [
      { source: 'flow', kind: 'message' },
      { source: 'internal', kind: 'message' },
      { source: 'internal', kind: 'wake' },
      { source: 'internal', kind: 'plan_approval' },
    ] satisfies MessageOrigin[]) {
      expect(isPersonAuthored({ messageOrigin })).toBe(false);
    }
    expect(isPersonAuthored({})).toBe(false);
    expect(isPersonAuthored(undefined)).toBe(false);
  });

  it('is false for a retried turn that a task dispatched', () => {
    expect(isPersonAuthored({ messageOrigin: regenerate, dispatchTaskId: 'task-1' })).toBe(false);
  });
});
