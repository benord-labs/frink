import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { buildTurnHistory, dataImageSrc } from './index';

function message(id: string, role: UIMessage['role'], parts: unknown[]): UIMessage {
  return { id, role, parts } as UIMessage;
}

describe('buildTurnHistory', () => {
  it('carries the plan in full and one line per tool call, in order', () => {
    const history = buildTurnHistory([
      message('u1', 'user', [{ type: 'text', text: 'Plan the auth refactor' }]),
      message('a1', 'assistant', [
        { type: 'text', text: 'Looking around.' },
        { type: 'tool-Read', input: { file_path: 'src/auth.ts', limit: 40 } },
        { type: 'tool-Bash', input: { command: `bun test\n${'x'.repeat(200)}` } },
        { type: 'tool-TodoWrite', input: { todos: [] } },
        {
          type: 'tool-frink-plan',
          input: {
            planText: '---\nstatus: draft\n---\n# Plan\n1. Move tokens',
            status: 'approved',
          },
        },
      ]),
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'Plan the auth refactor' },
      {
        role: 'assistant',
        content: [
          'Looking around.',
          '[Read] src/auth.ts',
          '[Bash] bun test',
          '[TodoWrite]',
          '<plan>\n# Plan\n1. Move tokens\n</plan>',
        ].join('\n'),
      },
    ]);
  });

  it('leaves out the message being sent, other roles, narration parts and empty messages', () => {
    const current = message('u2', 'user', [{ type: 'text', text: 'now build it' }]);
    const history = buildTurnHistory(
      [
        message('s1', 'system', [{ type: 'text', text: 'system note' }]),
        message('a1', 'assistant', [
          { type: 'reasoning', text: 'thinking' },
          { type: 'tool-Thinking', input: { text: 'private reasoning' } },
          { type: 'tool-SubagentText', input: { text: 'subagent prose' } },
        ]),
        message('u1', 'user', [{ type: 'text', text: '<!--TASK_BUBBLE:{}-->do it' }]),
        current,
      ],
      current,
    );

    expect(history).toEqual([{ role: 'user', content: 'do it' }]);
  });
});

describe('buildTurnHistory after compaction', () => {
  const compact = (data: Record<string, unknown>, id = 'compact-1') => ({
    type: 'data-compact',
    id,
    data: { state: 'output-available', ...data },
  });
  const summaryTurn = (summary: string) => ({
    role: 'user',
    content: `[Earlier conversation was compacted. Summary:]\n\n${summary}`,
  });
  const before = [
    message('u1', 'user', [{ type: 'text', text: 'old question' }]),
    message('a1', 'assistant', [{ type: 'text', text: 'old answer' }]),
  ];

  it('replaces everything before the boundary with its summary', () => {
    const history = buildTurnHistory([
      ...before,
      message('a2', 'assistant', [
        { type: 'text', text: 'pre-compaction work' },
        compact({ trigger: 'auto', summary: 'we discussed X' }),
        { type: 'text', text: 'carried on after' },
      ]),
      message('u3', 'user', [{ type: 'text', text: 'new question' }]),
    ]);

    expect(history).toEqual([
      summaryTurn('we discussed X'),
      { role: 'assistant', content: 'carried on after' },
      { role: 'user', content: 'new question' },
    ]);
  });

  it('falls back to an older summarised compaction when the newest has no summary', () => {
    const history = buildTurnHistory([
      ...before,
      message('a2', 'assistant', [compact({ summary: 'older summary' }, 'c1')]),
      message('u3', 'user', [{ type: 'text', text: 'between' }]),
      message('a3', 'assistant', [compact({}, 'c2')]),
    ]);

    expect(history).toEqual([summaryTurn('older summary'), { role: 'user', content: 'between' }]);
  });

  it.each([
    ['carries no summary', compact({})],
    ['is partial', compact({ summary: 'S', partial: true })],
    ['failed', { type: 'data-compact', id: 'c', data: { state: 'output-error', summary: 'S' } }],
  ])('leaves the history whole when the only compaction %s', (_name, part) => {
    const messages = [...before, message('a2', 'assistant', [part])];

    expect(buildTurnHistory(messages)).toEqual(buildTurnHistory(before));
  });
});

describe('dataImageSrc', () => {
  it('renders from the persisted base64, not the session-scoped blob url', () => {
    expect(
      dataImageSrc({
        url: 'blob:http://localhost/dead',
        base64Data: 'AAAA',
        mediaType: 'image/jpeg',
      }),
    ).toBe('data:image/jpeg;base64,AAAA');
  });

  it('renders a task-dispatched image that was queued without a url', () => {
    expect(dataImageSrc({ url: '', base64Data: 'AAAA' })).toBe('data:image/png;base64,AAAA');
  });

  it('falls back to the url when no inline data exists', () => {
    expect(dataImageSrc({ url: 'blob:http://localhost/live' })).toBe('blob:http://localhost/live');
    expect(dataImageSrc(undefined)).toBe('');
  });
});
