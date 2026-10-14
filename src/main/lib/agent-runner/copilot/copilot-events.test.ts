import type { JsonValue, SessionEvent } from '@github/copilot-sdk';
import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { createCopilotEventState, mapCopilotEvent } from './copilot-events';
import { IDLE, says, thinks, toolEnds, toolStarts } from './copilot-test-fixtures';

function mapAll(events: SessionEvent[]): UIMessageChunk[] {
  const state = createCopilotEventState();
  return events.flatMap((event) => mapCopilotEvent(event, state));
}

const usage = (inputTokens: number, outputTokens: number): SessionEvent => ({
  id: 'usage',
  parentId: null,
  timestamp: new Date(0).toISOString(),
  ephemeral: true,
  type: 'assistant.usage',
  data: { model: 'gpt-5', inputTokens, outputTokens },
});

describe('mapCopilotEvent', () => {
  it('streams text per message, and ends it before a thought or a card', () => {
    expect(
      mapAll([
        says('Hel'),
        says('lo'),
        thinks('hmm'),
        says('Next', 'message-2'),
        toolStarts('call-1', 'bash', { command: 'ls' }),
      ]),
    ).toEqual([
      { type: 'text-delta', id: 'message-1', delta: 'Hel' },
      { type: 'text-delta', id: 'message-1', delta: 'lo' },
      { type: 'text-end', id: 'message-1' },
      { type: 'reasoning-delta', id: 'reasoning-1', delta: 'hmm' },
      { type: 'text-delta', id: 'message-2', delta: 'Next' },
      { type: 'text-end', id: 'message-2' },
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'Bash' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
    ]);
  });

  it("leaves out a helper agent's own text and thoughts", () => {
    const child = (event: SessionEvent): SessionEvent => ({ ...event, agentId: 'helper' });
    expect(mapAll([child(says('inner')), child(thinks('inner'))])).toEqual([]);
  });

  it.each<[string, string, JsonValue, string, Record<string, string | undefined>]>([
    [
      'a command',
      'bash',
      { command: 'npm test', description: 'Run tests' },
      'Bash',
      { command: 'npm test' },
    ],
    [
      'a new file',
      'create',
      { path: '/p/a.txt', file_text: 'hi' },
      'Edit',
      { file_path: '/p/a.txt', old_string: '', new_string: 'hi' },
    ],
    [
      'an edit',
      'edit',
      { path: '/p/a.txt', old_str: 'a', new_str: 'b' },
      'Edit',
      { file_path: '/p/a.txt', old_string: 'a', new_string: 'b' },
    ],
    ['a read', 'view', { path: '/p/a.txt' }, 'Read', { file_path: '/p/a.txt' }],
    [
      'a fetch',
      'web_fetch',
      { url: 'https://example.com' },
      'WebFetch',
      { url: 'https://example.com' },
    ],
    ['any other tool', 'grep', { pattern: 'x' }, 'AgentTool', { description: 'grep' }],
    ['a patch', 'apply_patch', '*** Begin Patch', 'AgentTool', { description: 'apply_patch' }],
  ])('shows %s as its card', (_name, tool, args, toolName, input) => {
    expect(mapAll([toolStarts('call-1', tool, args)])).toEqual([
      { type: 'tool-input-start', toolCallId: 'call-1', toolName },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName, input },
    ]);
  });

  it('completes a card with its output, or its error', () => {
    expect(
      mapAll([toolEnds('call-1', true, 'file.txt'), toolEnds('call-2', false, 'Denied')]),
    ).toEqual([
      { type: 'tool-output-available', toolCallId: 'call-1', output: { output: 'file.txt' } },
      { type: 'tool-output-error', toolCallId: 'call-2', errorText: 'Denied' },
    ]);
  });

  it("adds up the turn's token use across model calls", () => {
    expect(mapAll([usage(10, 2), usage(30, 5)]).at(-1)).toEqual({
      type: 'message-metadata',
      messageMetadata: { inputTokens: 40, outputTokens: 7, totalTokens: 47 },
    });
  });

  it("shows Copilot's error, and nothing for an idle session", () => {
    const error: SessionEvent = {
      id: 'error',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      type: 'session.error',
      data: { errorType: 'quota', message: 'You have used your monthly quota.' },
    };
    expect(mapAll([error, IDLE])).toEqual([
      { type: 'error', errorText: 'You have used your monthly quota.' },
    ]);
  });
});
