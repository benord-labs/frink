import type { SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { assistantPartsStateFromChunks } from '../../../../shared/lib/assistant-parts';
import type { UIMessageChunk } from '../../claude/types';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import {
  collectChunks,
  fakeAcpAgent,
  RECORDED_OUTSIDE_DIRECTORY,
  RECORDED_REJECTED_COMMAND,
  RECORDED_REJECTED_WRITE,
  replayTurn,
  runnerParams,
  says,
} from './acp-test-fixtures';
import { runAcpAgent } from './index';

async function chunksOf(updates: SessionUpdate[]): Promise<UIMessageChunk[]> {
  const fake = fakeAcpAgent(async ({ client, sessionId }) => {
    for (const update of updates) await client.notify('session/update', { sessionId, update });
  });
  return collectChunks(runAcpAgent(runnerParams(), fake.start));
}

function toolCall(fields: Omit<ToolCallUpdate, 'toolCallId'>): SessionUpdate {
  return { sessionUpdate: 'tool_call_update', toolCallId: 't1', ...fields };
}

/** The last name and input a card was given, which is what the renderer ends up showing. */
function cardOf(chunks: UIMessageChunk[]) {
  const shown = chunks.filter((chunk) => chunk.type === 'tool-input-available').at(-1);
  return { toolName: shown?.toolName, input: shown?.input };
}

describe('tool cards for turns recorded from a real agent', () => {
  it('keeps the diff on the Edit card of a rejected write and ends it in the error state', async () => {
    const { script } = replayTurn(RECORDED_REJECTED_WRITE);

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fakeAcpAgent(script).start));

    const parts = assistantPartsStateFromChunks(chunks).parts;
    expect(parts.map((part) => part.type)).toEqual(['tool-Thinking', 'tool-Edit']);
    expect(parts[1]).toMatchObject({
      state: 'output-error',
      input: { file_path: '/workspace/project/hello.txt', old_string: '', new_string: 'hi' },
      errorText: 'The user rejected permission to use this specific tool call.',
    });
  });

  it('shows a rejected command as a Bash card with the command', async () => {
    const { script } = replayTurn(RECORDED_REJECTED_COMMAND);

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fakeAcpAgent(script).start));

    expect(assistantPartsStateFromChunks(chunks).parts).toMatchObject([
      { type: 'tool-Bash', state: 'output-error', input: { command: 'ls' } },
    ]);
  });

  it('says Frink could not check a call it refused without asking', async () => {
    // The same turn, with a key in the request Frink's rules cannot judge.
    const messages = RECORDED_OUTSIDE_DIRECTORY.messages.map((message) =>
      'permission' in message
        ? { permission: { ...message.permission, rawInput: { command: 'ls', env: {} } } }
        : message,
    );
    const { script } = replayTurn({ ...RECORDED_OUTSIDE_DIRECTORY, messages });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fakeAcpAgent(script).start));

    expect(assistantPartsStateFromChunks(chunks).parts).toMatchObject([
      {
        state: 'output-error',
        errorText: 'Frink could not check this action against your rules, so it was not allowed.',
      },
    ]);
  });
});

describe('who a refusal is shown as coming from', () => {
  it.each<[string, CodexApprovalCheck]>([
    ['throws', async () => Promise.reject(new Error('gate unavailable'))],
    ['gives no answer', async () => ({ allowed: null })],
  ])('shows Frink could not check a call when the permission check %s', async (_, check) => {
    const { script } = replayTurn(RECORDED_REJECTED_COMMAND);

    const chunks = await collectChunks(
      runAcpAgent(runnerParams({ checkApproval: check }), fakeAcpAgent(script).start),
    );

    expect(assistantPartsStateFromChunks(chunks).parts).toMatchObject([
      {
        type: 'tool-Bash',
        state: 'output-error',
        errorText: 'Frink could not check this action against your rules, so it was not allowed.',
      },
    ]);
  });
});

describe('tool cards', () => {
  it('shows a finished command with its output', async () => {
    const chunks = await chunksOf([
      toolCall({ kind: 'execute', title: 'List files', rawInput: { command: 'ls' } }),
      toolCall({
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'notes.txt' } }],
      }),
    ]);

    expect(cardOf(chunks)).toEqual({ toolName: 'Bash', input: { command: 'ls' } });
    expect(chunks).toContainEqual({
      type: 'tool-output-available',
      toolCallId: 't1',
      output: { output: 'notes.txt' },
    });
  });

  it.each<[string, Omit<ToolCallUpdate, 'toolCallId'>, ReturnType<typeof cardOf>]>([
    [
      'a command known only by its title',
      { kind: 'execute', title: 'Run tests' },
      { toolName: 'Bash', input: { command: 'Run tests' } },
    ],
    [
      'a read',
      { kind: 'read', locations: [{ path: '/a.txt' }] },
      { toolName: 'Read', input: { file_path: '/a.txt' } },
    ],
    [
      'a delete',
      { kind: 'delete', locations: [{ path: '/a.txt' }] },
      { toolName: 'Delete', input: { file_path: '/a.txt' } },
    ],
    [
      'a fetch',
      { kind: 'fetch', title: 'Fetch example.com' },
      { toolName: 'AgentTool', input: { description: 'Fetch example.com' } },
    ],
    [
      'a call with no kind',
      { title: 'Something' },
      { toolName: 'AgentTool', input: { description: 'Something' } },
    ],
  ])('shows %s', async (_name, fields, card) => {
    const chunks = await chunksOf([toolCall(fields)]);

    expect(chunks.filter((chunk) => chunk.type === 'tool-input-start')).toHaveLength(1);
    expect(cardOf(chunks)).toEqual(card);
  });

  it('reports a call that failed without saying why', async () => {
    const chunks = await chunksOf([toolCall({ kind: 'read', status: 'failed' })]);

    expect(chunks).toContainEqual({
      type: 'tool-output-error',
      toolCallId: 't1',
      errorText: 'The tool call failed.',
    });
  });

  it('starts a new text block after a card', async () => {
    const chunks = await chunksOf([says('before'), toolCall({ kind: 'read' }), says('after')]);

    const types = chunks.map((chunk) => chunk.type);
    expect(types.indexOf('text-end')).toBeLessThan(types.indexOf('tool-input-start'));
    const textIds = chunks.flatMap((chunk) => (chunk.type === 'text-start' ? [chunk.id] : []));
    expect(new Set(textIds).size).toBe(2);
  });
});
