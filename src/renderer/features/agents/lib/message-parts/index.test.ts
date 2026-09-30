import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { buildTurnHistory } from './index';

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
