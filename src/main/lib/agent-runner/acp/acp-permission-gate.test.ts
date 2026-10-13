import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalOutcome, CodexApprovalRequest } from '../codex/codex-events';
import {
  collectChunks,
  fakeAcpAgent,
  RECORDED_OPTIONS,
  RECORDED_OUTSIDE_DIRECTORY,
  RECORDED_REJECTED_COMMAND,
  RECORDED_REJECTED_WRITE,
  replayTurn,
  runnerParams,
} from './acp-test-fixtures';
import { type AcpRunnerParams, runAcpAgent } from './index';

const DENIED: ApprovalOutcome = { allowed: false, message: 'User denied permission' };

function gate(answer: (request: CodexApprovalRequest) => ApprovalOutcome) {
  const asked: CodexApprovalRequest[] = [];
  const checkApproval: AcpRunnerParams['checkApproval'] = async (request) => {
    asked.push(request);
    return answer(request);
  };
  return { asked, checkApproval };
}

/** One turn in which the agent reports `updates`, then asks permission for `toolCall`. */
async function ask(
  toolCall: ToolCallUpdate,
  checkApproval: AcpRunnerParams['checkApproval'],
  options: PermissionOption[] = RECORDED_OPTIONS,
  updates: ToolCallUpdate[] = [],
): Promise<RequestPermissionOutcome | undefined> {
  let outcome: RequestPermissionOutcome | undefined;
  const fake = fakeAcpAgent(async ({ client, sessionId }) => {
    for (const update of updates) {
      await client.notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'tool_call_update', ...update },
      });
    }
    const answer = await client.request('session/request_permission', {
      sessionId,
      toolCall,
      options,
    });
    outcome = answer.outcome;
  });
  await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fake.start));
  return outcome;
}

const ALLOW_ONCE = { outcome: 'selected', optionId: 'once' };
const REJECT_ONCE = { outcome: 'selected', optionId: 'reject' };

describe('permission requests recorded from a real agent', () => {
  it('asks about the file of a write and passes a denial on as the reject option', async () => {
    const { asked, checkApproval } = gate(() => DENIED);
    const { script, answers } = replayTurn(RECORDED_REJECTED_WRITE);

    await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fakeAcpAgent(script).start));

    expect(asked).toEqual([
      {
        toolName: 'Edit',
        input: { file_path: '/workspace/project/hello.txt' },
        reason: '/workspace/project/hello.txt',
      },
    ]);
    expect(answers).toEqual([REJECT_ONCE]);
  });

  it('asks about a command and answers allow-once although a lasting allow is offered', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));
    const { script, answers } = replayTurn(RECORDED_REJECTED_COMMAND);

    await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fakeAcpAgent(script).start));

    expect(asked).toEqual([{ toolName: 'Bash', input: { command: 'ls' }, reason: 'ls' }]);
    expect(answers).toEqual([ALLOW_ONCE]);
  });

  it('refuses a request for a directory outside the project without asking', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));
    const { script, answers } = replayTurn(RECORDED_OUTSIDE_DIRECTORY);

    await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fakeAcpAgent(script).start));

    expect(asked).toEqual([]);
    expect(answers).toEqual([REJECT_ONCE]);
  });
});

describe('what the permission gate is asked', () => {
  it('uses what earlier updates said when the request names only the call', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));

    const outcome = await ask({ toolCallId: 't1' }, checkApproval, RECORDED_OPTIONS, [
      { toolCallId: 't1', kind: 'execute', title: 'List files', rawInput: { command: 'ls' } },
    ]);

    expect(asked).toEqual([{ toolName: 'Bash', input: { command: 'ls' }, reason: 'List files' }]);
    expect(outcome).toEqual(ALLOW_ONCE);
  });

  it('refuses a request that describes its own step without a kind, whatever came before', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));

    const outcome = await ask(
      {
        toolCallId: 't1',
        kind: null,
        title: 'Open https://example.com',
        rawInput: { url: 'https://example.com' },
      },
      checkApproval,
      RECORDED_OPTIONS,
      [{ toolCallId: 't1', kind: 'read', locations: [{ path: '/workspace/project/a.txt' }] }],
    );

    expect(asked).toEqual([]);
    expect(outcome).toEqual(REJECT_ONCE);
  });

  it.each<[string, ToolCallUpdate]>([
    ['a call nothing was said about', { toolCallId: 'unknown' }],
    ['a command with no command text', { toolCallId: 't1', kind: 'execute', title: 'ls' }],
    ['a blank command', { toolCallId: 't1', kind: 'execute', rawInput: { command: '  ' } }],
    [
      'a command with arguments beside it',
      { toolCallId: 't1', kind: 'execute', rawInput: { command: 'git', args: ['push'] } },
    ],
    [
      'a command with a directory beside it',
      { toolCallId: 't1', kind: 'execute', rawInput: { command: 'rm -rf build', workdir: '/x' } },
    ],
    [
      'a read that carries a command list',
      {
        toolCallId: 't1',
        kind: 'read',
        locations: [{ path: '/workspace/project/a.txt' }],
        rawInput: { command: ['rm', '-rf', '/'] },
      },
    ],
    ['a fetch', { toolCallId: 't1', kind: 'fetch', title: 'Fetch https://example.com' }],
    ['a call of kind other', { toolCallId: 't1', kind: 'other', title: 'mcp tool' }],
    [
      'a call of kind other whose input is a command',
      { toolCallId: 't1', kind: 'other', rawInput: { command: 'ls' } },
    ],
    [
      'a call with no kind whose input is a command',
      { toolCallId: 't1', rawInput: { command: 'ls' } },
    ],
  ])('refuses %s without asking', async (_name, toolCall) => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));

    const outcome = await ask(toolCall, checkApproval);

    expect(asked).toEqual([]);
    expect(outcome).toEqual(REJECT_ONCE);
  });

  it('asks about the command as well when a read carries one', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));

    await ask(
      {
        toolCallId: 't1',
        kind: 'read',
        locations: [{ path: '/workspace/project/a.txt' }],
        rawInput: { command: 'cat a.txt' },
      },
      checkApproval,
    );

    expect(asked.map((request) => request.toolName)).toEqual(['Bash', 'Read']);
  });

  it('asks about every file an edit names and refuses the call when one is denied', async () => {
    const { asked, checkApproval } = gate((request) =>
      request.input.file_path === '/b' ? DENIED : { allowed: true },
    );

    const outcome = await ask(
      {
        toolCallId: 't1',
        kind: 'edit',
        locations: [{ path: '/a' }],
        content: [{ type: 'diff', path: '/b', oldText: 'x', newText: 'y' }],
      },
      checkApproval,
    );

    expect(asked.map((request) => request.input)).toEqual([
      { file_path: '/a' },
      { file_path: '/b' },
    ]);
    expect(outcome).toEqual(REJECT_ONCE);
  });

  it('asks about an empty path when a file action names no file', async () => {
    const { asked, checkApproval } = gate(() => DENIED);

    await ask({ toolCallId: 't1', kind: 'read' }, checkApproval);

    expect(asked).toEqual([{ toolName: 'Read', input: { file_path: '' }, reason: undefined }]);
  });
});

describe('the answer the agent receives', () => {
  const command: ToolCallUpdate = {
    toolCallId: 't1',
    kind: 'execute',
    rawInput: { command: 'ls' },
  };
  const lastingOnly: PermissionOption[] = [
    { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'never', kind: 'reject_always', name: 'Never allow' },
  ];

  it('is cancelled when only lasting options are offered, allowed or not', async () => {
    expect(await ask(command, async () => ({ allowed: true }), lastingOnly)).toEqual({
      outcome: 'cancelled',
    });
    expect(await ask(command, async () => DENIED, lastingOnly)).toEqual({ outcome: 'cancelled' });
  });

  it('is a refusal when the gate throws or cannot answer', async () => {
    const throwing = async () => {
      throw new Error('gate unavailable');
    };

    expect(await ask(command, throwing)).toEqual(REJECT_ONCE);
    expect(await ask(command, async () => ({ allowed: null }))).toEqual(REJECT_ONCE);
  });

  it('is cancelled when the user stops the turn while the gate is asking', async () => {
    const abortController = new AbortController();
    let outcome: RequestPermissionOutcome | undefined;
    let sawCancel = false;
    const fake = fakeAcpAgent(async ({ client, sessionId, cancelled }) => {
      void cancelled.then(() => {
        sawCancel = true;
      });
      const answer = await client.request('session/request_permission', {
        sessionId,
        toolCall: command,
        options: RECORDED_OPTIONS,
      });
      outcome = answer.outcome;
      return { stopReason: 'cancelled' };
    });
    const checkApproval = () =>
      new Promise<ApprovalOutcome>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(DENIED));
        queueMicrotask(() => abortController.abort());
      });

    await collectChunks(runAcpAgent(runnerParams({ checkApproval, abortController }), fake.start));

    await vi.waitFor(() => expect(outcome).toEqual({ outcome: 'cancelled' }));
    expect(sawCancel).toBe(true);
  });

  it('asks nothing more about a call once the user stops the turn', async () => {
    const abortController = new AbortController();
    const { asked, checkApproval } = gate(() => {
      abortController.abort();
      return { allowed: true };
    });
    let outcome: RequestPermissionOutcome | undefined;
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      const answer = await client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't1', kind: 'edit', locations: [{ path: '/a' }, { path: '/b' }] },
        options: RECORDED_OPTIONS,
      });
      outcome = answer.outcome;
      return { stopReason: 'cancelled' };
    });

    await collectChunks(runAcpAgent(runnerParams({ checkApproval, abortController }), fake.start));

    await vi.waitFor(() => expect(outcome).toEqual({ outcome: 'cancelled' }));
    expect(asked.map((request) => request.input)).toEqual([{ file_path: '/a' }]);
  });

  it('is cancelled, without asking, for a request that arrives after the turn has ended', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));
    let late: Promise<RequestPermissionOutcome> | undefined;
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      setTimeout(() => {
        late = client
          .request('session/request_permission', {
            sessionId,
            toolCall: command,
            options: RECORDED_OPTIONS,
          })
          .then((answer) => answer.outcome);
      }, 20);
    });

    await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fake.start));

    await vi.waitFor(() => expect(late).toBeDefined());
    expect(await late).toEqual({ outcome: 'cancelled' });
    expect(asked).toEqual([]);
  });

  it('is cancelled, without asking, for a request about another session', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));
    let outcome: RequestPermissionOutcome | undefined;
    const fake = fakeAcpAgent(async ({ client }) => {
      const answer = await client.request('session/request_permission', {
        sessionId: 'child-session',
        toolCall: command,
        options: RECORDED_OPTIONS,
      });
      outcome = answer.outcome;
    });

    await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fake.start));

    expect(outcome).toEqual({ outcome: 'cancelled' });
    expect(asked).toEqual([]);
  });
});
