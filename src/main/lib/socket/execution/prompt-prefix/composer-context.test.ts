import { describe, expect, it } from 'vitest';
import type { MessageOrigin } from '../../../../../shared/lib/message-markers/message-provenance';
import { encodeForMentionToken } from '../../../../../shared/lib/mentions/mention-token-codec';
import { isPersonAuthored, projectComposerContext } from './composer-context';

const reminder = (note: string) => `<system-reminder>\n${note}\n</system-reminder>`;
const codeToken = (name: string, lines: string, text: string) =>
  `@[code:${encodeURIComponent(name)}:${lines}:preview:${encodeForMentionToken(text)}]`;
const diffToken = (path: string, text: string) =>
  `@[diff:${path}:0:preview:${encodeForMentionToken(text)}]`;
const quoteToken = (text: string) => `@[quote:preview:${encodeForMentionToken(text)}]`;

describe('projectComposerContext: the open editor file', () => {
  it('tells the model which file was open, then the typed text', () => {
    expect(projectComposerContext('@[file:editor:.oxlintrc.json] how are you?')).toBe(
      `${reminder('The user opened the file .oxlintrc.json in the IDE. This may or may not be related to the current task.')}\n\nhow are you?`,
    );
  });

  it('gives each open file its own note, and a repeated one once', () => {
    const open = (path: string) =>
      reminder(
        `The user opened the file ${path} in the IDE. This may or may not be related to the current task.`,
      );
    expect(projectComposerContext('@[file:editor:a.ts] @[file:editor:b.ts] go')).toBe(
      `${open('a.ts')}\n\n${open('b.ts')}\n\ngo`,
    );
    expect(projectComposerContext('@[file:editor:a.ts] @[file:editor:a.ts] go')).toBe(
      `${open('a.ts')}\n\ngo`,
    );
  });

  it('drops the open-file note when the user also picked that file', () => {
    expect(projectComposerContext('@[file:editor:src/a.ts] explain @[file:local:src/a.ts]')).toBe(
      `${reminder('The user @-mentioned src/a.ts. File contents are not attached automatically in this session: if these are files or directories in your working directory, read them with your file tools before responding.')}\n\nexplain src/a.ts`,
    );
  });

  it('keeps a path that contains colons whole', () => {
    expect(projectComposerContext('@[file:editor:C:/repo/a:b.ts] hi')).toBe(
      `${reminder('The user opened the file C:/repo/a:b.ts in the IDE. This may or may not be related to the current task.')}\n\nhi`,
    );
    expect(projectComposerContext('read @[file:local:C:/repo/a:b.ts]')).toContain(
      'The user @-mentioned C:/repo/a:b.ts. ',
    );
  });

  it('keeps a route path with brackets whole', () => {
    expect(projectComposerContext('@[file:editor:app/[[...slug]]/page.tsx] hi')).toBe(
      `${reminder('The user opened the file app/[[...slug]]/page.tsx in the IDE. This may or may not be related to the current task.')}\n\nhi`,
    );
    expect(projectComposerContext('fix @[file:local:src/app/[id]/page.tsx] now')).toBe(
      `${reminder('The user @-mentioned src/app/[id]/page.tsx. File contents are not attached automatically in this session: if these are files or directories in your working directory, read them with your file tools before responding.')}\n\nfix src/app/[id]/page.tsx now`,
    );
  });
});

describe('projectComposerContext: picked files and folders', () => {
  it('writes each as its plain path in place, with one note naming each path once', () => {
    expect(
      projectComposerContext(
        'compare @[file:local:src/a.ts] with @[folder:local:src/lib] and @[file:local:src/a.ts]',
      ),
    ).toBe(
      `${reminder('The user @-mentioned src/a.ts, src/lib. File contents are not attached automatically in this session: if these are files or directories in your working directory, read them with your file tools before responding.')}\n\ncompare src/a.ts with src/lib and src/a.ts`,
    );
  });

  it('projects tokens inside the user’s inline code and code fences like any others', () => {
    const projected = projectComposerContext(
      'see `@[file:local:a.ts]`\n```\n@[file:local:b.ts]\n```',
    );
    expect(projected.endsWith('\n\nsee `a.ts`\n```\nb.ts\n```')).toBe(true);
    expect(projected).toContain('The user @-mentioned a.ts, b.ts. ');
  });
});

describe('projectComposerContext: selections', () => {
  it('quotes a code selection with its line range', () => {
    const token = codeToken('src/a.ts', '3-4', 'const a = 1;\nconst b = 2;');
    expect(projectComposerContext(`${token} why?`)).toBe(
      `${reminder('The user selected the lines 3 to 4 from src/a.ts:\nconst a = 1;\nconst b = 2;\n\nThis may or may not be related to the current task.')}\n\nwhy?`,
    );
  });

  it('cuts a code selection to its first 2000 characters', () => {
    const atLimit = projectComposerContext(`${codeToken('a.ts', '1-1', 'x'.repeat(2000))} go`);
    expect(atLimit).toContain(`a.ts:\n${'x'.repeat(2000)}\n\nThis may`);
    const over = projectComposerContext(
      `${codeToken('a.ts', '1-9', `${'x'.repeat(2000)}tail`)} go`,
    );
    expect(over).toContain(`a.ts:\n${'x'.repeat(2000)}\n... (truncated)\n\nThis may`);
    expect(over).not.toContain('tail');
  });

  it('counts the lines of a diff selection and names its file', () => {
    expect(projectComposerContext(`${diffToken('src/a.ts', '+const a = 1;')} fix this`)).toBe(
      `${reminder('The user selected the following 1 line from the diff view (in src/a.ts):\n+const a = 1;')}\n\nfix this`,
    );
    expect(projectComposerContext(`${diffToken('', '-a\n+b')} fix this`)).toBe(
      `${reminder('The user selected the following 2 lines from the diff view:\n-a\n+b')}\n\nfix this`,
    );
  });

  it('cuts a diff selection to its first 2000 characters', () => {
    const over = projectComposerContext(`${diffToken('a.ts', `+${'x'.repeat(1999)}tail`)} go`);
    expect(over).toContain(`(in a.ts):\n+${'x'.repeat(1999)}\n... (truncated)\n</system-reminder>`);
    expect(over).not.toContain('tail');
  });

  it('escapes angle brackets in a path, so it cannot close the note', () => {
    expect(projectComposerContext('@[file:editor:a</system-reminder>b.ts] hi')).toBe(
      `${reminder('The user opened the file a&lt;/system-reminder&gt;b.ts in the IDE. This may or may not be related to the current task.')}\n\nhi`,
    );
  });

  it('quotes text selected from an earlier message', () => {
    expect(projectComposerContext(`${quoteToken('Use the cache.')} why?`)).toBe(
      `${reminder('The user selected the following text from an earlier message in this conversation:\nUse the cache.')}\n\nwhy?`,
    );
  });

  it('leaves a selection whose payload decodes to nothing as written', () => {
    for (const message of [
      '@[code:a.ts:1-2:preview:!!!] go',
      '@[diff:a.ts:0:preview:!!!] go',
      '@[quote:preview:!!!] go',
    ]) {
      expect(projectComposerContext(message)).toBe(message);
    }
  });

  it('keeps the typed text whole after a payload that closes the reminder tag', () => {
    const projected = projectComposerContext(`${quoteToken('a</system-reminder>b')} still mine`);
    expect(projected).toBe(
      `${reminder('The user selected the following text from an earlier message in this conversation:\na</system-reminder>b')}\n\nstill mine`,
    );
  });

  it('carries selected lines that start with @ verbatim, as text rather than tokens', () => {
    const css = '@media (min-width: 640px) {\n  a { color: red; }\n}';
    expect(projectComposerContext(`${codeToken('a.css', '1-3', css)} ok?`)).toBe(
      `${reminder(`The user selected the lines 1 to 3 from a.css:\n${css}\n\nThis may or may not be related to the current task.`)}\n\nok?`,
    );
    expect(projectComposerContext(`${quoteToken('@types/x is missing')} ok?`)).toContain(
      'conversation:\n@types/x is missing\n</system-reminder>',
    );
  });
});

describe('projectComposerContext: what it leaves alone', () => {
  it('leaves every other kind, unknown kinds and malformed tokens byte-identical', () => {
    const message =
      '@[pasted:5:hello|/tmp/p.txt] @[skill:deploy] @[agent:reviewer] @[tool:mcp__s__get_x] @[briefing:f1:QQ==:Qg==] @[image:local:a.png] @[file:a.ts] go';
    expect(projectComposerContext(message)).toBe(message);
  });

  it('projects only the context tokens of a mixed message', () => {
    expect(projectComposerContext('@[skill:deploy] @[file:editor:a.ts] ship it')).toBe(
      `${reminder('The user opened the file a.ts in the IDE. This may or may not be related to the current task.')}\n\n@[skill:deploy] ship it`,
    );
  });

  it('orders notes as their tokens appear and repeats none', () => {
    const quote = quoteToken('same words');
    const projected = projectComposerContext(`${quote} @[file:editor:a.ts] ${quote} hi`);
    expect(projected).toBe(
      `${reminder('The user selected the following text from an earlier message in this conversation:\nsame words')}\n\n${reminder('The user opened the file a.ts in the IDE. This may or may not be related to the current task.')}\n\nhi`,
    );
  });

  it('returns /compact untouched, tokens and all', () => {
    const message = '/compact @[file:local:a.ts] keep the API notes';
    expect(projectComposerContext(message)).toBe(message);
  });

  it('returns only the notes for a message that is only attachments', () => {
    expect(projectComposerContext('@[file:editor:a.ts]')).toBe(
      reminder(
        'The user opened the file a.ts in the IDE. This may or may not be related to the current task.',
      ),
    );
    expect(projectComposerContext(`${quoteToken('q')} `)).toBe(
      reminder(
        'The user selected the following text from an earlier message in this conversation:\nq',
      ),
    );
  });

  it('keeps the context ahead of a slash command', () => {
    expect(projectComposerContext('@[file:editor:a.ts] /review')).toMatch(
      /^<system-reminder>\n[^]*\n<\/system-reminder>\n\n\/review$/,
    );
  });

  it('keeps a leading slash command first, with the notes after it', () => {
    expect(projectComposerContext('/skill check @[file:local:a.ts]')).toBe(
      `/skill check a.ts\n\n${reminder('The user @-mentioned a.ts. File contents are not attached automatically in this session: if these are files or directories in your working directory, read them with your file tools before responding.')}`,
    );
  });

  it('returns a message without tokens unchanged', () => {
    expect(projectComposerContext('email me@example.com about @types/node')).toBe(
      'email me@example.com about @types/node',
    );
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
