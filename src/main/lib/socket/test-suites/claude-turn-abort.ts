import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTaskById } from '../../db/repos/tasks';
import { channelOwner, getChannelToken } from '../../mcp/execution-identity';
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
  TURN_END,
} from './claude-turn-bindings';
import {
  type Cli,
  type CliScript,
  type Frame,
  mockQuery,
  never,
  UNCLEAN_RESULT,
} from './claude-query-fake';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type ClaudeTurnAbortHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & {
  claudeQueryMock: ReturnType<typeof vi.fn>;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

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

/** Turn 1 leaves background work running so the chat holds; `wake()` then has the CLI run `burst`
 * on its own, as a wake burst streaming into the arming message. */
function wakingCli(burst: (cli: Cli) => AsyncGenerator<Frame>) {
  let wake = () => {};
  const woke = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const script: CliScript = async function* (cli) {
    await cli.prompt.next();
    await cli.stop([RUNNING_TASK]);
    yield* TURN_END;
    await woke;
    yield* burst(cli);
    await never();
  };
  return { script, wake };
}

const streamed = () => JSON.stringify(vi.mocked(socketClient.sendStreamChunkDirect).mock.calls);
const completes = () =>
  vi
    .mocked(socketClient.sendExecuteCompleteDirect)
    .mock.calls.map(([complete]) => complete)
    .filter((complete) => complete.subChatId === payload.subChatId);

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
    registerStoplessAdoptedTurnTests(harness);
  });
}

/** A Stop-less adopted turn (StopFailure, interrupt) must not read as "nothing pending": that kept
 * the session idle, and an idle retirement then killed the Workflow it held. */
function registerStoplessAdoptedTurnTests(harness: ClaudeTurnAbortHarness): void {
  const { claudeQueryMock, handleRemoteExecute } = harness;

  it('an adopted turn that ends with no Stop keeps holding on the work it took over', async () => {
    const info = vi.spyOn(log, 'info');
    mockQuery(
      claudeQueryMock,
      heldCli(async () => {}),
    );
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    await followUp(harness);

    expect(hasWakeHold(payload.subChatId)).toBe(true);
    expect(getSession(payload.subChatId)?.retained).toBeNull();
    expect(info).toHaveBeenCalledWith(
      `[Socket Executor] Adopted turn ended for ${payload.subChatId}: re-armed from the carried-forward Stop (Command)`,
    );
  });

  // The StopFailure shape: an API error ends the adopted turn with an error result and no Stop. Such
  // a turn used to read as unclean with nothing pending and end the session, Workflow and all.
  it('an adopted turn that fails with no Stop keeps holding on the work it took over', async () => {
    mockQuery(claudeQueryMock, async function* (cli) {
      await cli.prompt.next();
      await cli.stop([RUNNING_TASK]);
      yield* TURN_END;
      await cli.prompt.next();
      yield UNCLEAN_RESULT;
      await never();
    });
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    await followUp(harness);

    expect(hasWakeHold(payload.subChatId)).toBe(true);
    expect(claudeQueryMock).toHaveBeenCalledOnce();
  });

  it('an adopted turn whose own Stop lists nothing ends the wait', async () => {
    mockQuery(
      claudeQueryMock,
      heldCli(async (cli) => {
        await cli.stop([]);
      }),
    );
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    await followUp(harness);

    expect(hasWakeHold(payload.subChatId)).toBe(false);
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
      // The adopted turn's own Stop reports the work settled, so the wait ends with it. Without a
      // Stop the turn would carry the held work forward and re-arm.
      yield* heldCli(async () => {
        await cli.stop([]);
      })(cli);
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

    // Stop closed the held CLI outright, so it cannot keep running a burst beside the new one.
    expect(held.close).toHaveBeenCalled();
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(channelOwner(heldChannel)).toBeUndefined();
    expect(getChannelToken(payload.subChatId, 'claude')).not.toBe(heldChannel);
  });

  it('Stop mid-burst on a held chat closes the CLI: nothing after Stop streams, the burst persists', async () => {
    let enterTool = () => {};
    const inTool = new Promise<void>((resolve) => {
      enterTool = resolve;
    });
    let finishTool = () => {};
    const toolDone = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    const cli = wakingCli(async function* () {
      yield {
        type: 'assistant',
        chunks: [{ type: 'text-delta', id: 'b', delta: 'checking build' }],
      };
      enterTool();
      await toolDone; // a long foreground tool that outlives the Stop
      yield { type: 'assistant', chunks: [{ type: 'text-delta', id: 'l', delta: 'after stop' }] };
      yield* TURN_END;
    });
    const query = mockQuery(claudeQueryMock, cli.script);
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    await vi.waitFor(() => expect(completes().some((c) => c.continuesWakeHold)).toBe(true));
    cli.wake();
    await inTool;

    handleRemoteStop(payload);
    finishTool();
    await tick();

    expect(query.close).toHaveBeenCalled();
    expect(streamed()).toContain('checking build');
    expect(streamed()).not.toContain('after stop');
    const burst = completes().find((c) => c.wakeBurst);
    expect(JSON.stringify(burst?.finalParts)).toContain('checking build');
    expect(burst?.continuesWakeHold).toBe(false);
    expect(hasWakeHold(payload.subChatId)).toBe(false);
    expect(socketClient.sendWakeHoldChanged).not.toHaveBeenCalledWith(
      expect.objectContaining({ endReason: 'failed' }),
    );
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });

  it('a chat delete closes a held CLI too, not just Stop', async () => {
    const query = mockQuery(claudeQueryMock, heldCli(never));
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });

    abortActiveExecutionsForSubChats([payload.subChatId], 'chat-deleted');
    await tick();

    expect(query.close).toHaveBeenCalled();
    expect(hasWakeHold(payload.subChatId)).toBe(false);
  });

  it('a wait that ends on its own only closes stdin, so an answer written after EOF still lands', async () => {
    const cli = wakingCli(async function* (wakingCliSide) {
      yield {
        type: 'assistant',
        chunks: [{ type: 'text-delta', id: 'w', delta: 'coverage done' }],
      };
      await wakingCliSide.stop([]); // nothing left in flight: the wait is over
      yield { type: 'result' };
      yield { type: 'assistant', chunks: [{ type: 'text-delta', id: 'f', delta: 'final answer' }] };
      yield { type: 'result' };
    });
    const query = mockQuery(claudeQueryMock, cli.script);
    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    cli.wake();
    await tick();

    expect(getSession(payload.subChatId)?.queue.closed).toBe(true);
    expect(query.close).not.toHaveBeenCalled();
    expect(streamed()).toContain('final answer');
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
