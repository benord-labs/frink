import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { type CursorSdkMessage, createCursorEventState, mapCursorMessage } from './cursor-events';
import { sdk } from './cursor-test-fixtures';

function mapAll(messages: CursorSdkMessage[]): UIMessageChunk[] {
  const state = createCursorEventState();
  return messages.flatMap((message) => mapCursorMessage(message, state));
}

const success = (value: Record<string, string>) => ({ status: 'success', value });

describe('mapCursorMessage', () => {
  it('streams text as one run, and starts a new run after a thought or a card', () => {
    expect(
      mapAll([
        sdk.says('Hel'),
        sdk.says('lo'),
        sdk.thinks('hmm'),
        sdk.says('Next'),
        sdk.runs('call-1', 'shell', { command: 'ls' }),
        sdk.says('After'),
      ]),
    ).toEqual([
      { type: 'text-delta', id: 'cursor-text-1', delta: 'Hel' },
      { type: 'text-delta', id: 'cursor-text-1', delta: 'lo' },
      { type: 'text-end', id: 'cursor-text-1' },
      { type: 'reasoning-delta', id: 'cursor-thinking', delta: 'hmm' },
      { type: 'text-delta', id: 'cursor-text-2', delta: 'Next' },
      { type: 'text-end', id: 'cursor-text-2' },
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'Bash' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
      { type: 'text-delta', id: 'cursor-text-3', delta: 'After' },
    ]);
  });

  it('shows each tool as its card, and any other tool by name', () => {
    const cards = mapAll([
      sdk.runs('e', 'edit', { path: '/p/a.ts' }),
      sdk.runs('r', 'read', { path: '/p/b.ts' }),
      sdk.runs('d', 'delete', { path: '/p/c.ts' }),
      sdk.runs('g', 'grep', { pattern: 'x' }),
    ]).filter((chunk) => chunk.type === 'tool-input-available');
    expect(cards.map((chunk) => [chunk.toolName, chunk.input])).toEqual([
      ['Edit', { file_path: '/p/a.ts' }],
      ['Read', { file_path: '/p/b.ts' }],
      ['Delete', { file_path: '/p/c.ts' }],
      ['AgentTool', { description: 'grep' }],
    ]);
  });

  it("shows an edit's diff, a command's output and a read's text when the call succeeds", () => {
    const failed = success({ stdout: '', stderr: 'ls: nope: No such file' });
    expect(
      mapAll([
        sdk.ran('e', 'edit', { path: '/p/a.ts' }, success({ diffString: '+hi' })),
        sdk.ran('s', 'shell', { command: 'ls' }, success({ stdout: 'a.ts', stderr: 'warn' })),
        sdk.ran('f', 'shell', { command: 'ls nope' }, failed),
        sdk.ran('r', 'read', { path: '/p/a.ts' }, success({ content: 'hi' })),
      ]),
    ).toEqual([
      { type: 'tool-output-available', toolCallId: 'e', output: { output: '+hi' } },
      { type: 'tool-output-available', toolCallId: 's', output: { output: 'a.ts\nwarn' } },
      {
        type: 'tool-output-available',
        toolCallId: 'f',
        output: { output: 'ls: nope: No such file' },
      },
      { type: 'tool-output-available', toolCallId: 'r', output: { output: 'hi' } },
    ]);
  });

  it("shows a failed call's error, or a plain one when Cursor gives none", () => {
    expect(
      mapAll([
        sdk.ran(
          'a',
          'shell',
          { command: 'ls' },
          { status: 'error', error: { message: 'Blocked' } },
        ),
        sdk.ran('b', 'shell', { command: 'ls' }, { status: 'rejected' }),
      ]),
    ).toEqual([
      { type: 'tool-output-error', toolCallId: 'a', errorText: 'Blocked' },
      { type: 'tool-output-error', toolCallId: 'b', errorText: 'The tool call failed.' },
    ]);
  });

  it('reports token usage, and shows no status or system message', () => {
    expect(mapAll([sdk.status('RUNNING'), sdk.usage(120, 30)])).toEqual([
      {
        type: 'message-metadata',
        messageMetadata: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      },
    ]);
  });
});
