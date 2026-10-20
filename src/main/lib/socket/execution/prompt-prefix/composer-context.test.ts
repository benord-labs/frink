import { describe, expect, it } from 'vitest';
import type { MessageOrigin } from '../../../../../shared/lib/message-markers/message-provenance';
import { encodeForMentionToken } from '../../../../../shared/lib/mentions/mention-token-codec';
import { HIDDEN_WAKE_MARKER } from '../../../../../shared/lib/message-markers/hidden-wake-marker';
import { TRIGGER_BUBBLE_MARKER } from '../../../../../shared/lib/trigger-bubble-marker';
import {
  codexComposerContext,
  type ComposerNote,
  isPersonAuthored,
  projectComposerContext,
  recapComposerTokens,
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
const PASTED = '/Users/me/Library/Application Support/Frink/claude-sessions/s1/pasted/notes.txt';
const pastedToken = (path: string) => `@[pasted:120:first words|${path}]`;
const unavailable = (what: string) => `If no ${what} is available to you, say so.`;
const attached = (path: string): ComposerNote => ({
  kind: 'attached_file',
  text: `The user attached the file \`${path}\`. Its contents are not in this message: read it with your file tools before responding.`,
});
const skill = (name: string): ComposerNote => ({
  kind: 'skill',
  text: `The user's message names the skill "${name}". If they are asking you to run it, run that skill with any arguments they gave (in Claude Code, with the Skill tool). If they only mention it, do not run it. ${unavailable('skill by that name')}`,
});
const agent = (name: string): ComposerNote => ({
  kind: 'agent',
  text: `The user has expressed a desire to invoke the agent "${name}". Please invoke the agent appropriately, passing in the required context to it. ${unavailable('agent by that name')}`,
});
const tool = (named: string): ComposerNote => ({
  kind: 'tool',
  text: `The user picked the tool ${named}. Use it where it fits their request. ${unavailable('such tool')}`,
});

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

describe('projectComposerContext: attached files, skills, agents and tools', () => {
  it('writes a pasted file as its path in backticks, with a note to read it', () => {
    expect(projectComposerContext(`summarise ${pastedToken(PASTED)} please`)).toEqual({
      text: `summarise \`${PASTED}\` please`,
      notes: [attached(PASTED)],
    });
  });

  it('never lets a pasted path at the start of the prompt read as a slash command', () => {
    const { text, notes } = projectComposerContext(`${pastedToken('/tmp/a.png')} what is this?`);
    expect(text).toBe('`/tmp/a.png` what is this?');
    expect(notes).toEqual([attached('/tmp/a.png')]);
  });

  it('sends a phone attachment with nothing typed as its path, its note on the channel', () => {
    expect(projectComposerContext(pastedToken(PASTED))).toEqual({
      text: `\`${PASTED}\``,
      notes: [attached(PASTED)],
    });
  });

  it('keeps a pasted path with colons and pipes whole', () => {
    expect(projectComposerContext('@[pasted:9:a|b|C:/x/y:z.txt] go').notes).toEqual([
      attached('C:/x/y:z.txt'),
    ]);
  });

  it('writes a skill or agent as its name, with a note on what to do with it', () => {
    expect(projectComposerContext('run @[skill:deploy] then ask @[agent:reviewer]')).toEqual({
      text: 'run deploy then ask reviewer',
      notes: [skill('deploy'), agent('reviewer')],
    });
  });

  it('writes an MCP tool as its label and names its server and full name in the note', () => {
    expect(projectComposerContext('use @[tool:mcp__figma__get_design_context] here')).toEqual({
      text: 'use Get Design Context here',
      notes: [
        tool('"get_design_context" from the "figma" MCP server (`mcp__figma__get_design_context`)'),
      ],
    });
  });

  it('names a tool id of another shape whole', () => {
    expect(projectComposerContext('use @[tool:Bash] here').notes).toEqual([tool('"Bash"')]);
  });

  it('escapes angle brackets in names and paths', () => {
    expect(projectComposerContext('@[agent:a</system-reminder>] go').notes).toEqual([
      agent('a&lt;/system-reminder&gt;'),
    ]);
  });
});

describe('projectComposerContext: what it leaves alone', () => {
  it('leaves unknown kinds and malformed tokens byte-identical', () => {
    const message =
      '@[briefing:f1:QQ==:Qg==] @[image:local:a.png] @[file:a.ts] @[pasted:5:no-path] @[skill:] go';
    expect(projectComposerContext(message)).toEqual({ text: message, notes: [] });
  });

  it('projects the known tokens of a mixed message and leaves the rest', () => {
    expect(
      projectComposerContext('@[skill:deploy] @[image:local:a.png] @[file:editor:a.ts] ship it'),
    ).toEqual({
      text: 'deploy @[image:local:a.png] ship it',
      notes: [skill('deploy'), opened('a.ts')],
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
    const message = '@[image:local:a.png] /review';
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

  it('marks attached files, skills, agents and tools as Frink’s own sentences', () => {
    expect(codexComposerContext([attached('/a.txt'), skill('s'), agent('a'), tool('"t"')])).toEqual(
      {
        frink_attached_file_1: { kind: 'application', value: attached('/a.txt').text },
        frink_skill_1: { kind: 'application', value: skill('s').text },
        frink_agent_1: { kind: 'application', value: agent('a').text },
        frink_tool_1: { kind: 'application', value: tool('"t"').text },
      },
    );
  });

  it('is empty for a message with no notes', () => {
    expect(codexComposerContext([])).toEqual({});
  });
});

describe('recapComposerTokens', () => {
  it('writes each token as what it was, with nothing that asks the model to act', () => {
    const recap = recapComposerTokens(
      [
        '@[file:editor:open.ts] @[file:local:src/a.ts] @[folder:local:src/lib]',
        pastedToken(PASTED),
        '@[skill:deploy] @[agent:reviewer] @[tool:mcp__figma__get_x] go',
      ].join(' '),
    );
    expect(recap).toBe(
      `[had open.ts open in the IDE] src/a.ts src/lib [attached file ${PASTED}] [skill deploy] [agent reviewer] [tool mcp__figma__get_x] go`,
    );
  });

  it('drops the open file when the user also picked it', () => {
    expect(recapComposerTokens('@[file:editor:a.ts] explain @[file:local:a.ts]')).toBe(
      'explain a.ts',
    );
  });

  it('writes selections with their source and a body cut at 2000 characters', () => {
    expect(recapComposerTokens(`${codeToken('a.ts', '3-4', 'x\ny')} why?`)).toBe(
      '[selected lines 3-4 of a.ts:\nx\ny] why?',
    );
    expect(recapComposerTokens(`${diffToken('a.ts', '+a')} fix`)).toBe(
      '[selected 1 line from the diff of a.ts:\n+a] fix',
    );
    expect(recapComposerTokens(`${diffToken('', '-a\n+b')} fix`)).toBe(
      '[selected 2 lines from the diff view:\n-a\n+b] fix',
    );
    expect(recapComposerTokens(quoteToken(`${'x'.repeat(2000)}tail`))).toBe(
      `[quoted an earlier message:\n${'x'.repeat(2000)}\n... (truncated)]`,
    );
  });

  it('returns a turn without known tokens unchanged', () => {
    for (const content of ['plain words', '@[image:local:a.png] hi', '@[code:a.ts:1-2:p:!!!] go']) {
      expect(recapComposerTokens(content)).toBe(content);
    }
  });
});

describe('isPersonAuthored', () => {
  const regenerate: MessageOrigin = { source: 'internal', kind: 'regenerate' };

  it('is true for a person’s message and a regenerated turn', () => {
    expect(isPersonAuthored({ messageOrigin: { source: 'person', kind: 'message' } }, 'hi')).toBe(
      true,
    );
    expect(isPersonAuthored({ messageOrigin: regenerate }, 'hi')).toBe(true);
  });

  it('is false for text Frink wrote, such as a triggered task’s opening or a wake', () => {
    const person = { messageOrigin: { source: 'person', kind: 'message' } } as const;
    expect(
      isPersonAuthored({ messageOrigin: regenerate }, `${TRIGGER_BUBBLE_MARKER}{}-->\n\nGo`),
    ).toBe(false);
    expect(isPersonAuthored(person, `${HIDDEN_WAKE_MARKER}Continue`)).toBe(false);
  });

  it('is false for flow, dispatch, wake, plan approval and unclassified sends', () => {
    for (const messageOrigin of [
      { source: 'flow', kind: 'message' },
      { source: 'internal', kind: 'message' },
      { source: 'internal', kind: 'wake' },
      { source: 'internal', kind: 'plan_approval' },
    ] satisfies MessageOrigin[]) {
      expect(isPersonAuthored({ messageOrigin }, 'hi')).toBe(false);
    }
    expect(isPersonAuthored({}, 'hi')).toBe(false);
    expect(isPersonAuthored(undefined, 'hi')).toBe(false);
  });

  it('is false for a retried turn that a task dispatched', () => {
    expect(isPersonAuthored({ messageOrigin: regenerate, dispatchTaskId: 'task-1' }, 'hi')).toBe(
      false,
    );
  });
});
