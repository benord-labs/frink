import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSessionsForTest, getSession } from '../../claude-session-registry';
import * as socketClient from '../../client';
import { ChatBusyError } from '../../execution/send-admission';
import { _hasActiveExecutionForTests } from '../../executor';
import { type CliScript, type Frame, mockQuery } from '../claude-query-fake';
import { answeringCli, deferred, replies } from '../claude-warm-session';
import { TURN_END } from '../claude-turn-bindings';
import type { ExecutorPermissionHarness } from '../executor-codex-permissions';

type Harness = Pick<ExecutorPermissionHarness, 'basePayload' | 'handleRemoteExecute'> & {
  claudeQueryMock: ReturnType<typeof vi.fn>;
};
type Payload = Parameters<Harness['handleRemoteExecute']>[0];
type Send = (message: string, overrides?: Partial<Payload>) => Promise<void>;

let payload: Harness['basePayload'];
const idle = () => getSession(payload.subChatId)?.retained ?? null;
const PEER_INIT = { type: 'system', subtype: 'init' };
const PEER_RESULT = { type: 'result', origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/1.sock' } };

/** The turn an idle CLI starts when another session messages it: `init`, the model's reply, then a
 * result whose origin names the sender. */
async function* peerTurn() {
  yield PEER_INIT;
  yield { type: 'assistant', chunks: [{ type: 'text-delta', id: 'p1', delta: 'peer reply' }] };
  yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-held' } }] };
  yield PEER_RESULT;
}

/** A warm CLI that answers the chat's first send, then does `then` while it idles. */
function answerOnceThen(
  then: (prompt: AsyncIterator<SDKUserMessage>) => AsyncGenerator<Frame>,
  prompts: SDKUserMessage[] = [],
): CliScript {
  return async function* ({ prompt }) {
    const first = await prompt.next();
    if (!first.done) prompts.push(first.value);
    yield { chunks: [{ type: 'text-delta', id: 'r1', delta: 'reply 1' }] };
    yield* TURN_END;
    yield* then(prompt);
  };
}

/** Registers the cases proving a turn an idle chat's CLI starts on its own (a message from another
 * session) is read and rendered by an execute that adopts it, instead of killing the CLI. */
export function registerSelfStartedTurnTests(harness: Harness): void {
  const { claudeQueryMock } = harness;
  const send = (message: string, overrides: Partial<Payload> = {}) =>
    harness.handleRemoteExecute({ ...payload, message, ...overrides });
  describe('turns a kept-idle CLI starts on its own', () => {
    beforeEach(() => {
      payload = { ...harness.basePayload, subChatId: randomUUID() };
    });
    afterEach(() => __resetSessionsForTest());
    registerCases(claudeQueryMock, send);
  });
}

function registerCases(claudeQueryMock: Harness['claudeQueryMock'], send: Send): void {
  const selfStarted = { messageOrigin: { source: 'internal', kind: 'self-started' } } as const;
  /** Main's dispatch of a self-started turn, as client.sendMessage hands it to the executor. */
  const dispatchInto = (adopts: Array<Promise<void>>) =>
    vi.mocked(socketClient.sendMessage).mockImplementation(async (sent, options) => {
      expect(sent).toMatchObject({ selfStarted: true, userMessage: { parts: [] } });
      expect(options).toEqual({ rejectIfBusy: true });
      // Never dispatched over the chat's own run: that run is still finishing its turn.
      expect(_hasActiveExecutionForTests(payload.subChatId)).toBe(false);
      adopts.push(send('', { assistantMessageId: 'peer-msg', delivery: selfStarted }));
    });

  it('a message from another session to an idle chat streams as its own reply, CLI kept', async () => {
    const peer = deferred();
    const prompts: SDKUserMessage[] = [];
    const afterReply = async function* (prompt: AsyncIterator<SDKUserMessage>) {
      await peer.promise;
      yield* peerTurn();
      await prompt.next();
    };
    mockQuery(claudeQueryMock, answerOnceThen(afterReply, prompts));
    const adopts: Array<Promise<void>> = [];
    dispatchInto(adopts);

    await send('first');
    peer.release();
    await vi.waitFor(() => expect(adopts).toHaveLength(1));
    await adopts[0];

    expect(replies()).toEqual(['reply 1', 'peer reply']);
    expect(socketClient.sendStreamChunkDirect).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: 'peer-msg' }),
    );
    expect(prompts).toHaveLength(1);
    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(idle()).not.toBeNull();
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });

  it('a turn the CLI starts right after a reply waits for that run to finish, never aborting it', async () => {
    const rightAfterReply = async function* (prompt: AsyncIterator<SDKUserMessage>) {
      yield* peerTurn();
      await prompt.next();
    };
    mockQuery(claudeQueryMock, answerOnceThen(rightAfterReply));
    const adopts: Array<Promise<void>> = [];
    dispatchInto(adopts);

    await send('first', { assistantMessageId: 'msg-1' });
    await vi.waitFor(() => expect(adopts).toHaveLength(1));
    await adopts[0];

    expect(socketClient.sendExecuteCompleteDirect).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: 'msg-1' }),
    );
    expect(replies()).toEqual(['reply 1', 'peer reply']);
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });

  it('a self-started turn nobody can take retires its CLI, and the next send spawns fresh', async () => {
    const peer = deferred();
    const first = mockQuery(
      claudeQueryMock,
      answerOnceThen(async function* () {
        await peer.promise;
        yield* peerTurn();
      }),
    );
    vi.mocked(socketClient.sendMessage).mockRejectedValueOnce(
      new Error('Chat execution is not ready.'),
    );

    await send('first');
    peer.release();
    await vi.waitFor(() => expect(getSession(payload.subChatId)).toBeUndefined());
    expect(first.close).toHaveBeenCalled();

    mockQuery(claudeQueryMock, answeringCli());
    await send('second', { sessionId: 'sess-held' });
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
  });

  it('a send that wins the race to the chat is answered first, then the turn is adopted', async () => {
    const peer = deferred();
    mockQuery(
      claudeQueryMock,
      answerOnceThen(async function* (prompt) {
        await peer.promise;
        yield* peerTurn();
        await prompt.next();
      }),
    );
    const adopts: Array<Promise<void>> = [];
    dispatchInto(adopts);
    vi.mocked(socketClient.sendMessage).mockRejectedValueOnce(new ChatBusyError());

    await send('first');
    peer.release();
    await vi.waitFor(() => expect(adopts).toHaveLength(1));
    await adopts[0];

    expect(socketClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(replies()).toEqual(['reply 1', 'peer reply']);
  });

  it('an adoption that finds nothing to adopt ends quietly: no error, nothing parked', async () => {
    await send('', { assistantMessageId: 'peer-msg', delivery: selfStarted });

    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
    expect(_hasActiveExecutionForTests(payload.subChatId)).toBe(false);
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });
}
