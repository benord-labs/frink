import { randomUUID } from 'node:crypto';
import type {
  BackgroundTaskSummary,
  CanUseTool,
  McpServerStatus,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTaskById } from '../../db/repos/tasks';
import { channelOwner, getChannelToken } from '../../mcp/execution-identity';
import type { TaskStopHook } from '../../task-stop-hook';
import { getSession } from '../claude-session-registry';
import { hasWakeHold, releaseWakeHold } from '../claude-wake-hold';
import * as socketClient from '../client';
import { withMessageAdmission } from '../execution/send-admission';
import { abortActiveExecutionsForSubChats, handleRemoteStop } from '../executor';
import { getActiveExecution } from '../streaming/execution-registry';
import { beginLiveStreamCompletion, getLiveStreamSeed } from '../streaming/live-stream';
import {
  expireQuestion,
  flowDriven,
  RUNNING_TASK,
  runningTask,
  stopInput,
  TURN_END,
} from './claude-turn-bindings';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type ClaudeTurnAbortHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & {
  claudeQueryMock: ReturnType<typeof vi.fn>;
};

type QueryInput = {
  prompt: AsyncIterable<SDKUserMessage>;
  options: {
    abortController?: AbortController;
    hooks: { Stop: Array<{ hooks: TaskStopHook[] }> };
    canUseTool: CanUseTool;
  };
};
type Cli = {
  prompt: AsyncIterator<SDKUserMessage>;
  options: QueryInput['options'];
  stop: (backgroundTasks?: BackgroundTaskSummary[]) => ReturnType<TaskStopHook>;
};
/** An SDK message as the suite's transformer mock reads it. */
type Frame = { type?: string; chunks?: object[] };
/** The CLI's side of one fake session: reads prompts, fires hooks, and yields frames. */
type CliScript = (cli: Cli) => AsyncGenerator<Frame>;

const DONE = { done: true, value: undefined } as const;
/** A tool call that never answers, like a CLI blocked in a silent tool. */
export const never = () => new Promise<never>(() => {});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Registers the next SDK query. Like the real `Query`, `close()`/`return()` end the pending read
 * at once and an aborted `abortController` option fails it as a user abort. */
export function mockQuery(
  claudeQueryMock: ClaudeTurnAbortHarness['claudeQueryMock'],
  cli: CliScript,
) {
  let ended = false;
  let end: (error?: Error) => void = () => {};
  const stopped = new Promise<IteratorResult<Frame>>((resolve, reject) => {
    end = (error) => {
      ended = true;
      if (error) reject(error);
      else resolve(DONE);
    };
  });
  stopped.catch(() => {});
  const query = {
    close: vi.fn(() => end()),
    return: vi.fn(async () => {
      end();
      await new Promise((resolve) => setImmediate(resolve));
      return DONE;
    }),
    interrupt: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async (_model?: string) => {}),
    applyFlagSettings: vi.fn(async (_settings: Record<string, unknown>) => {}),
    initializationResult: vi.fn(async () => ({})),
    mcpServerStatus: vi.fn(async (): Promise<McpServerStatus[]> => []),
  };
  claudeQueryMock.mockImplementationOnce(({ prompt, options }: QueryInput) => {
    options.abortController?.signal.addEventListener('abort', () =>
      end(new Error('Claude Code process aborted by user')),
    );
    const stop = (backgroundTasks: BackgroundTaskSummary[] = []) =>
      options.hooks.Stop[0].hooks[0](stopInput(backgroundTasks));
    const frames = cli({ prompt: prompt[Symbol.asyncIterator](), options, stop });
    return Object.assign(query, {
      next: () => (ended ? stopped : Promise.race([frames.next(), stopped])),
      [Symbol.asyncIterator]() {
        return this;
      },
    });
  });
  return query;
}

/** Turn 1 leaves background work running so the session is held; `adopted` plays the CLI through
 * the follow-up turn that takes the hold over. */
const heldCli = (adopted: (cli: Cli) => Promise<void>) =>
  async function* (cli: Cli) {
    await cli.prompt.next();
    await cli.stop([RUNNING_TASK]);
    yield* TURN_END;
    await cli.prompt.next();
    await adopted(cli);
    yield* TURN_END;
    await never();
  };

/** Resolves once the CLI script reaches the silent tool call. */
function silentTool() {
  let reach = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return {
    reached,
    enter: () => {
      reach();
      return never();
    },
  };
}

let payload: ClaudeTurnAbortHarness['basePayload'];
const followUp = (harness: ClaudeTurnAbortHarness, assistantMessageId = 'msg-adopting') =>
  harness.handleRemoteExecute({ ...payload, assistantMessageId, message: 'follow-up' });

/** Registers the cases proving an execute abort ends the Claude session its turn is attached to —
 * and only while it is attached. */
export function registerClaudeTurnAbortTests(harness: ClaudeTurnAbortHarness): void {
  describe('Claude turn abort', () => {
    beforeEach(() => {
      payload = { ...harness.basePayload, subChatId: randomUUID() };
      vi.mocked(getTaskById).mockImplementation(async (_db, id) => runningTask(id));
    });
    afterEach(() => releaseWakeHold(payload.subChatId, 'test cleanup'));
    registerAttachedAbortTests(harness);
    registerDetachedAbortTests(harness);
  });
}

function registerAttachedAbortTests(harness: ClaudeTurnAbortHarness): void {
  const { claudeQueryMock, handleRemoteExecute } = harness;

  it('Stop during a silent tool on an adopted turn ends the session and the turn at once', async () => {
    const tool = silentTool();
    const query = mockQuery(claudeQueryMock, heldCli(tool.enter));
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });

    const adopting = followUp(harness);
    await tool.reached;
    const token = getChannelToken(payload.subChatId, 'claude');
    handleRemoteStop(payload);
    await adopting;

    expect(query.close).toHaveBeenCalledOnce();
    expect(channelOwner(token)).toBeUndefined();
    expect(getSession(payload.subChatId)).toBeUndefined();
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
    expect(socketClient.sendStreamSettledDirect).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: 'msg-adopting' }),
    );
  });

  it('a send during a silent adopted tool supersedes it without a hang, on exactly one new query', async () => {
    const tool = silentTool();
    mockQuery(claudeQueryMock, heldCli(tool.enter));
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    const adopting = followUp(harness);
    await tool.reached;

    mockQuery(claudeQueryMock, async function* ({ prompt }) {
      await prompt.next();
      yield { chunks: [{ type: 'text-delta', id: 'dup', delta: 'fresh reply' }] };
      yield* TURN_END;
      await never();
    });
    await followUp(harness, 'msg-duplicate');
    await adopting;

    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
    expect(socketClient.sendStreamChunkDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessageId: 'msg-duplicate',
        chunk: expect.objectContaining({ type: 'text-delta' }),
      }),
    );
  });

  it('Stop on a fresh turn still files as a user stop: partial reply kept, no error, no interruption', async () => {
    const tool = silentTool();
    mockQuery(claudeQueryMock, async function* ({ prompt }) {
      await prompt.next();
      yield { chunks: [{ type: 'text-delta', id: 'partial', delta: 'halfway there' }] };
      await tool.enter();
    });

    const run = handleRemoteExecute({ ...payload, message: 'long task' });
    await tool.reached;
    handleRemoteStop(payload);
    await run;

    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(socketClient.sendExecuteCompleteDirect).toHaveBeenCalledWith(
        expect.objectContaining({ assistantMessageId: payload.assistantMessageId }),
      ),
    );
    const [complete] = vi.mocked(socketClient.sendExecuteCompleteDirect).mock.calls.at(-1) ?? [];
    expect(JSON.stringify(complete?.finalParts)).toContain('halfway there');
    expect(complete?.metadata).toBeUndefined();
  });

  it('a renderer reload mid-turn still records the involuntary interruption', async () => {
    const tool = silentTool();
    mockQuery(claudeQueryMock, async function* ({ prompt }) {
      await prompt.next();
      yield { chunks: [{ type: 'text-delta', id: 'partial', delta: 'halfway there' }] };
      await tool.enter();
    });

    const run = handleRemoteExecute({ ...payload, message: 'long task' });
    await tool.reached;
    abortActiveExecutionsForSubChats([payload.subChatId], 'renderer-reload');
    await run;

    expect(socketClient.sendErrorDirect).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: payload.assistantMessageId }),
      expect.objectContaining({ metadata: { interruptedBy: 'renderer-reload' } }),
    );
  });
}

function registerDetachedAbortTests(harness: ClaudeTurnAbortHarness): void {
  const { claudeQueryMock, handleRemoteExecute } = harness;

  it('an abort after the turn ended leaves the held session for the follow-up to adopt', async () => {
    let arming: AbortController | undefined;
    const query = mockQuery(claudeQueryMock, async function* (cli) {
      arming = getActiveExecution(payload.subChatId)?.controller;
      yield* heldCli(async () => {})(cli);
    });
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    const token = getChannelToken(payload.subChatId, 'claude');

    arming?.abort();
    await tick();

    expect(query.close).not.toHaveBeenCalled();
    expect(channelOwner(token)).toBeDefined();
    expect(hasWakeHold(payload.subChatId)).toBe(true);
    await followUp(harness);
    expect(claudeQueryMock).toHaveBeenCalledOnce();
  });

  it('a phone send admitted into a held chat takes the hold over on the same CLI, aborting nothing', async () => {
    let arming: AbortController | undefined;
    mockQuery(claudeQueryMock, async function* (cli) {
      arming = getActiveExecution(payload.subChatId)?.controller;
      yield* heldCli(async () => {})(cli);
    });
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    expect(hasWakeHold(payload.subChatId)).toBe(true);
    // The socket client is mocked here, so mark the stream held as its transport does.
    const armed = await vi.waitFor(() => {
      const complete = vi.mocked(socketClient.sendExecuteCompleteDirect).mock.calls.at(-1)?.[0];
      if (!complete?.continuesWakeHold || !complete.streamEpoch) throw new Error('not held yet');
      return { ...complete, streamEpoch: complete.streamEpoch, continuesWakeHold: true };
    });
    beginLiveStreamCompletion(armed);
    expect(getLiveStreamSeed(payload.subChatId).streams).toEqual([
      expect.objectContaining({ status: 'held' }),
    ]);

    // The phone's path: admission refuses only a live execution, so this dispatches into the hold.
    await withMessageAdmission(payload.subChatId, true, (started) =>
      handleRemoteExecute({
        ...payload,
        assistantMessageId: 'msg-phone',
        message: 'follow-up from the phone',
        onExecutionStarted: started,
      }),
    );

    expect(hasWakeHold(payload.subChatId)).toBe(false);
    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(arming?.signal.aborted).toBe(false);
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });

  it("a send after Stop on a held chat spawns a CLI whose channel the held CLI can't reach", async () => {
    const held = mockQuery(claudeQueryMock, heldCli(never));
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    const heldChannel = getSession(payload.subChatId)?.channel;
    expect(channelOwner(heldChannel)).toBeDefined();
    handleRemoteStop(payload);
    mockQuery(claudeQueryMock, async function* ({ prompt }) {
      await prompt.next();
      yield* TURN_END;
      await never();
    });

    await followUp(harness);

    // Stop only closed the held CLI's stdin: it may still be mid-burst, making MCP calls.
    expect(held.close).not.toHaveBeenCalled();
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(channelOwner(heldChannel)).toBeUndefined();
    expect(getChannelToken(payload.subChatId, 'claude')).not.toBe(heldChannel);
  });

  it('a question park on an adopted flow turn ends the session once; the abort after it closes nothing', async () => {
    let adopting: AbortController | undefined;
    const query = mockQuery(
      claudeQueryMock,
      heldCli(async ({ options }) => {
        adopting = getActiveExecution(payload.subChatId)?.controller;
        expireQuestion(options.canUseTool);
        await never();
      }),
    );
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    flowDriven();
    await followUp(harness);
    await vi.waitFor(() => expect(adopting?.signal.aborted).toBe(true));
    await tick();

    expect(query.return).toHaveBeenCalledOnce();
    expect(query.close).not.toHaveBeenCalled();
    expect(query.interrupt).not.toHaveBeenCalled();
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });
}
