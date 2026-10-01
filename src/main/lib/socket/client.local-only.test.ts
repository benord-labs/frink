import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Chat dispatch and streaming run in-process; nothing here opens a network connection.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/tmp/frink-test-home' : '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { finalizeAssistantMessageLocalMock, upsertAssistantMessageLocalMock, setStreamIdLocalMock } =
  vi.hoisted(() => ({
    finalizeAssistantMessageLocalMock: vi.fn(async (): Promise<{ messages: never[] } | null> => ({
      messages: [],
    })),
    upsertAssistantMessageLocalMock: vi.fn(async () => {}),
    setStreamIdLocalMock: vi.fn(async () => {}),
  }));

vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({}) as unknown) }));
vi.mock('../db/repos/project-ai-accounts', () => ({ assertChatLogin: vi.fn() }));

vi.mock('../credentials', () => ({
  getClaudeCodeTokenByLabel: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  // Mirrors the real predicate (credentials.ts): passthrough rows are token-null by design,
  // so `passthrough` — not token presence — is what the spawn pre-flight gates on.
  isResolvedCredential: (
    cred: { token?: string | null; passthrough?: boolean } | null | undefined,
  ) => !!cred?.token || cred?.passthrough === true,
}));

// client.ts imports these under local aliases (`setStreamId as setStreamIdLocal`), so the factory
// must export the module's REAL names or the aliased import resolves to nothing.
vi.mock('../db/repos/sub-chats', () => ({
  appendUserMessage: vi.fn(async () => {}),
  getSubChatById: vi.fn(async () => ({ sessionId: null })),
  listSubChatsByChat: vi.fn(async () => []),
  markPlanApproved: vi.fn(async () => {}),
  pickOldestSubChat: vi.fn(() => null),
  setStreamId: setStreamIdLocalMock,
  upsertAssistantMessage: upsertAssistantMessageLocalMock,
  finalizeAssistantMessage: finalizeAssistantMessageLocalMock,
}));

import { BrowserWindow } from 'electron';
import * as sentry from '../sentry/init';
import {
  onPermissionRequest,
  onPermissionResponse,
  sendErrorDirect,
  sendExecuteCompleteDirect,
  sendPermissionDismiss,
  sendPermissionRequest,
  sendPermissionResponse,
  sendStreamChunkDirect,
  sendStreamSettledDirect,
} from './client';
import {
  _clearActiveExecutionsForTests,
  getExecutionStreamEpoch,
  releaseExecutionOwnershipForWebContents,
  setActiveExecution,
} from './streaming/execution-registry';
import {
  _clearLiveStreamRegistryForTests,
  finishHeldLiveStreams,
  getLiveStreamSeed,
  recordLiveStreamStart,
  resolveLiveStreamEpoch,
} from './streaming/live-stream';

/** Registers the fence the executor records before every stream; a fence-less checkpoint
 * lazily imports sentry/init, which must settle before the test file ends. */
const startStream = (subChatId: string, streamEpoch?: string) =>
  recordLiveStreamStart({
    chatId: 'c1',
    subChatId,
    assistantMessageId: 'a1',
    streamEpoch: streamEpoch ?? resolveLiveStreamEpoch(subChatId, 'a1'),
  });

describe('socket client', () => {
  it('sendPermissionRequest delivers payload to local listeners', () => {
    const listener = vi.fn();
    onPermissionRequest(listener);
    sendPermissionRequest({
      chatId: 'c1',
      subChatId: 's1',
      requestId: 'r1',
      type: 'bash',
      path: 'echo hello',
      operation: 'bash',
    } as unknown as Parameters<typeof sendPermissionRequest>[0]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('sendPermissionResponse delivers payload to local listeners', () => {
    const listener = vi.fn();
    onPermissionResponse(listener);
    sendPermissionResponse({
      chatId: 'c1',
      subChatId: 's1',
      requestId: 'r1',
      approved: true,
    } as unknown as Parameters<typeof sendPermissionResponse>[0]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Timeout-pop path: the dismiss broadcasts straight to the renderer so the
  // timed-out card is removed.
  it('sendPermissionDismiss broadcasts socket:permission-dismiss to the renderer', () => {
    const send = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([
      { isDestroyed: () => false, webContents: { isCrashed: () => false, send } },
    ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);

    sendPermissionDismiss({ requestId: 'r1', chatId: 'c1', subChatId: 's1' });

    expect(send).toHaveBeenCalledWith('socket:permission-dismiss', {
      requestId: 'r1',
      chatId: 'c1',
      subChatId: 's1',
    });
  });

  it('broadcasts an epoch terminal for a stopped zero-chunk run', () => {
    const send = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([
      { isDestroyed: () => false, webContents: { isCrashed: () => false, send } },
    ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
    setActiveExecution('zero-chunk', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });

    sendStreamSettledDirect({ chatId: 'c1', subChatId: 'zero-chunk', assistantMessageId: 'a1' });

    expect(send).toHaveBeenCalledWith(
      'socket:stream-settled',
      expect.objectContaining({
        subChatId: 'zero-chunk',
        assistantMessageId: 'a1',
        streamEpoch: expect.any(String),
      }),
    );
  });
});

/**
 * Local IPC is linear: every window receives the same ordered delta and never receives cumulative
 * `parts`. Main retains snapshots only for bounded recovery seeds and SQLite checkpoints.
 */
describe('stream chunk parts cadence', () => {
  const captureBroadcasts = () => {
    const send = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      { isDestroyed: () => false, webContents: { isCrashed: () => false, id: 1, send } },
    ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
    return send;
  };

  const chunkAt = (subChatId: string, messageIndex: number, type = 'tool-input-delta') => ({
    chatId: 'c1',
    subChatId,
    assistantMessageId: 'a1',
    chunk: { type } as never,
    parts: [{ type: 'text', text: 'snapshot' }] as never,
    messageIndex,
  });

  beforeEach(() => {
    finalizeAssistantMessageLocalMock.mockReset();
    finalizeAssistantMessageLocalMock.mockResolvedValue({ messages: [] });
    upsertAssistantMessageLocalMock.mockClear();
    setStreamIdLocalMock.mockClear();
    _clearActiveExecutionsForTests();
    _clearLiveStreamRegistryForTests();
  });

  it('retains the bounded final seed in a non-durable terminal when SQLite finalize fails', async () => {
    const send = captureBroadcasts();
    finalizeAssistantMessageLocalMock.mockRejectedValueOnce(new Error('database unavailable'));

    startStream('finalize-failure');
    await sendExecuteCompleteDirect({
      chatId: 'c1',
      subChatId: 'finalize-failure',
      assistantMessageId: 'a1',
      finalParts: [{ type: 'text', text: 'recoverable answer' }],
    });

    expect(send).toHaveBeenCalledWith('socket:execute-complete', expect.any(Object));
    expect(send).toHaveBeenCalledWith(
      'socket:stream-settled',
      expect.objectContaining({
        subChatId: 'finalize-failure',
        terminalDurability: { durability: 'non-durable' },
      }),
    );
    expect(getLiveStreamSeed('finalize-failure').terminals[0]).toMatchObject({
      status: 'settled',
      durability: 'non-durable',
      parts: [{ type: 'text', text: 'recoverable answer' }],
    });
  });

  it('treats a missing finalize row as a non-durable terminal with a bounded seed', async () => {
    const send = captureBroadcasts();
    finalizeAssistantMessageLocalMock.mockResolvedValueOnce(null);

    startStream('missing-finalize-row');
    await sendExecuteCompleteDirect({
      chatId: 'c1',
      subChatId: 'missing-finalize-row',
      assistantMessageId: 'a1',
      finalParts: [{ type: 'text', text: 'recoverable answer' }],
    });

    expect(send).toHaveBeenCalledWith(
      'socket:stream-settled',
      expect.objectContaining({ terminalDurability: { durability: 'non-durable' } }),
    );
    expect(getLiveStreamSeed('missing-finalize-row').terminals[0]).toMatchObject({
      status: 'settled',
      durability: 'non-durable',
      parts: [{ type: 'text', text: 'recoverable answer' }],
    });
  });

  it('durably finalizes a partial transcript before publishing its error terminal', async () => {
    const send = captureBroadcasts();
    let finishFinalize = () => {};
    finalizeAssistantMessageLocalMock.mockReturnValueOnce(
      new Promise<{ messages: never[] }>((resolve) => {
        finishFinalize = () => resolve({ messages: [] });
      }),
    );
    const finalParts = [{ type: 'text', text: 'recoverable tail' }];
    startStream('partial-error', 'error-epoch');
    const completion = sendErrorDirect(
      {
        chatId: 'c1',
        subChatId: 'partial-error',
        assistantMessageId: 'a1',
        streamEpoch: 'error-epoch',
        error: 'provider failed',
        category: 'PROVIDER_ERROR',
      },
      {
        chatId: 'c1',
        subChatId: 'partial-error',
        assistantMessageId: 'a1',
        streamEpoch: 'error-epoch',
        finalParts,
        metadata: { interruptedBy: 'renderer-crashed' },
      },
    );

    await vi.waitFor(() => expect(finalizeAssistantMessageLocalMock).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalledWith('socket:error', expect.any(Object));
    finishFinalize();
    await completion;

    expect(finalizeAssistantMessageLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      'partial-error',
      'a1',
      finalParts,
      null,
      { interruptedBy: 'renderer-crashed' },
      // The epoch's fence, so a turn whose transcript was replaced cannot finalize back into it.
      expect.any(Number),
    );
    expect(send.mock.calls.filter(([channel]) => channel === 'socket:error')).toHaveLength(1);
    expect(send).not.toHaveBeenCalledWith('socket:execute-complete', expect.any(Object));
    expect(send).not.toHaveBeenCalledWith('socket:stream-settled', expect.any(Object));
    expect(getLiveStreamSeed('partial-error').terminals[0]).toMatchObject({
      status: 'error',
      streamEpoch: 'error-epoch',
      category: 'PROVIDER_ERROR',
      durability: 'committed',
    });
  });

  it('settles a held completion when Stop retracts the wait during SQLite finalize', async () => {
    const send = captureBroadcasts();
    let finishFinalize = () => {};
    finalizeAssistantMessageLocalMock.mockReturnValueOnce(
      new Promise<{ messages: never[] }>((resolve) => {
        finishFinalize = () => resolve({ messages: [] });
      }),
    );

    startStream('held-finalize-race');
    const completion = sendExecuteCompleteDirect({
      chatId: 'c1',
      subChatId: 'held-finalize-race',
      assistantMessageId: 'a1',
      finalParts: [{ type: 'text', text: 'durable answer' }],
      continuesWakeHold: true,
    });
    await vi.waitFor(() => expect(finalizeAssistantMessageLocalMock).toHaveBeenCalledOnce());
    expect(getLiveStreamSeed('held-finalize-race').streams[0]?.status).toBe('held');

    finishHeldLiveStreams('held-finalize-race');
    expect(getLiveStreamSeed('held-finalize-race').streams[0]?.status).toBe('settling');
    finishFinalize();
    await completion;

    expect(getLiveStreamSeed('held-finalize-race').terminals[0]).toMatchObject({
      status: 'settled',
      durability: 'committed',
    });
    expect(send).toHaveBeenCalledWith(
      'socket:stream-settled',
      expect.objectContaining({ subChatId: 'held-finalize-race' }),
    );
  });

  it('broadcasts one settlement when a durable held completion retracts after finalize', async () => {
    const send = captureBroadcasts();
    startStream('held-finalize-first');
    await sendExecuteCompleteDirect({
      chatId: 'c1',
      subChatId: 'held-finalize-first',
      assistantMessageId: 'a1',
      finalParts: [{ type: 'text', text: 'durable answer' }],
      continuesWakeHold: true,
    });

    const [finished] = finishHeldLiveStreams('held-finalize-first');
    expect(finished?.terminalDurability).toEqual({ durability: 'committed' });
    sendStreamSettledDirect({
      chatId: 'c1',
      subChatId: 'held-finalize-first',
      assistantMessageId: 'a1',
      streamEpoch: finished?.streamEpoch,
      terminalDurability: { durability: 'committed' },
    });
    sendStreamSettledDirect({
      chatId: 'c1',
      subChatId: 'held-finalize-first',
      assistantMessageId: 'a1',
      streamEpoch: finished?.streamEpoch,
      terminalDurability: { durability: 'committed' },
    });

    expect(send.mock.calls.filter(([channel]) => channel === 'socket:stream-settled')).toHaveLength(
      1,
    );
    expect(getLiveStreamSeed('held-finalize-first').terminals[0]?.status).toBe('settled');
  });

  it('settles a retained held seed as non-durable when Stop precedes failed finalize', async () => {
    const send = captureBroadcasts();
    let failFinalize = (_error: Error) => {};
    finalizeAssistantMessageLocalMock.mockReturnValueOnce(
      new Promise<{ messages: never[] }>((_resolve, reject) => {
        failFinalize = reject;
      }),
    );

    startStream('held-finalize-failure');
    const completion = sendExecuteCompleteDirect({
      chatId: 'c1',
      subChatId: 'held-finalize-failure',
      assistantMessageId: 'a1',
      finalParts: [{ type: 'text', text: 'only complete copy' }],
      continuesWakeHold: true,
    });
    await vi.waitFor(() => expect(finalizeAssistantMessageLocalMock).toHaveBeenCalledOnce());
    finishHeldLiveStreams('held-finalize-failure');
    failFinalize(new Error('database unavailable'));
    await completion;

    expect(getLiveStreamSeed('held-finalize-failure').terminals[0]).toMatchObject({
      status: 'settled',
      durability: 'non-durable',
      parts: [{ type: 'text', text: 'only complete copy' }],
    });
    expect(send).toHaveBeenCalledWith(
      'socket:stream-settled',
      expect.objectContaining({ terminalDurability: { durability: 'non-durable' } }),
    );
  });

  it('settles an older completion when a same-id epoch starts during SQLite finalize', async () => {
    const send = captureBroadcasts();
    let finishFinalize = () => {};
    finalizeAssistantMessageLocalMock.mockReturnValueOnce(
      new Promise<{ messages: never[] }>((resolve) => {
        finishFinalize = () => resolve({ messages: [] });
      }),
    );
    setActiveExecution('aba-finalize', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });
    const olderEpoch = getExecutionStreamEpoch('aba-finalize', 'a1');
    startStream('aba-finalize', olderEpoch);
    sendStreamChunkDirect({
      ...chunkAt('aba-finalize', 0, 'text-delta'),
      streamEpoch: olderEpoch,
    });
    const olderCompletion = sendExecuteCompleteDirect({
      chatId: 'c1',
      subChatId: 'aba-finalize',
      assistantMessageId: 'a1',
      streamEpoch: olderEpoch,
      finalParts: [{ type: 'text', text: 'older answer' }],
    });
    await vi.waitFor(() => expect(finalizeAssistantMessageLocalMock).toHaveBeenCalledOnce());

    setActiveExecution('aba-finalize', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });
    const newerEpoch = getExecutionStreamEpoch('aba-finalize', 'a1');
    if (!newerEpoch) throw new Error('replacement execution did not receive an epoch');
    recordLiveStreamStart({
      chatId: 'c1',
      subChatId: 'aba-finalize',
      assistantMessageId: 'a1',
      streamEpoch: newerEpoch,
    });
    sendStreamChunkDirect({
      ...chunkAt('aba-finalize', 0, 'text-delta'),
      streamEpoch: newerEpoch,
    });
    finishFinalize();
    await olderCompletion;

    expect(send).toHaveBeenCalledWith(
      'socket:stream-settled',
      expect.objectContaining({
        streamEpoch: olderEpoch,
        terminalDurability: { durability: 'committed' },
      }),
    );
    expect(getLiveStreamSeed('aba-finalize')).toEqual({
      streams: [expect.objectContaining({ streamEpoch: newerEpoch })],
      terminals: [
        expect.objectContaining({
          streamEpoch: olderEpoch,
          durability: 'committed',
        }),
      ],
    });
  });

  it('settles a retained held epoch after a same-id replacement starts', async () => {
    const send = captureBroadcasts();
    setActiveExecution('aba-held', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });
    const olderEpoch = getExecutionStreamEpoch('aba-held', 'a1');
    if (!olderEpoch) throw new Error('held execution did not receive an epoch');
    recordLiveStreamStart({
      chatId: 'c1',
      subChatId: 'aba-held',
      assistantMessageId: 'a1',
      streamEpoch: olderEpoch,
    });
    await sendExecuteCompleteDirect({
      chatId: 'c1',
      subChatId: 'aba-held',
      assistantMessageId: 'a1',
      streamEpoch: olderEpoch,
      finalParts: [{ type: 'text', text: 'held answer' }],
      continuesWakeHold: true,
    });

    setActiveExecution('aba-held', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });
    const newerEpoch = getExecutionStreamEpoch('aba-held', 'a1');
    if (!newerEpoch) throw new Error('replacement execution did not receive an epoch');
    recordLiveStreamStart({
      chatId: 'c1',
      subChatId: 'aba-held',
      assistantMessageId: 'a1',
      streamEpoch: newerEpoch,
    });

    const [finished] = finishHeldLiveStreams('aba-held');
    sendStreamSettledDirect({
      chatId: 'c1',
      subChatId: 'aba-held',
      assistantMessageId: 'a1',
      streamEpoch: finished?.streamEpoch,
      terminalDurability: finished?.terminalDurability,
    });

    expect(send).toHaveBeenCalledWith(
      'socket:stream-settled',
      expect.objectContaining({ streamEpoch: olderEpoch }),
    );
    expect(getLiveStreamSeed('aba-held')).toEqual({
      streams: [expect.objectContaining({ streamEpoch: newerEpoch })],
      terminals: [expect.objectContaining({ streamEpoch: olderEpoch })],
    });
  });

  it('publishes an older error after a same-id epoch starts during SQLite finalize', async () => {
    const send = captureBroadcasts();
    let finishFinalize = () => {};
    finalizeAssistantMessageLocalMock.mockReturnValueOnce(
      new Promise<{ messages: never[] }>((resolve) => {
        finishFinalize = () => resolve({ messages: [] });
      }),
    );
    setActiveExecution('aba-error', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });
    const olderEpoch = getExecutionStreamEpoch('aba-error', 'a1');
    if (!olderEpoch) throw new Error('erroring execution did not receive an epoch');
    recordLiveStreamStart({
      chatId: 'c1',
      subChatId: 'aba-error',
      assistantMessageId: 'a1',
      streamEpoch: olderEpoch,
    });
    sendStreamChunkDirect({ ...chunkAt('aba-error', 0, 'text-delta'), streamEpoch: olderEpoch });
    const olderError = sendErrorDirect(
      {
        chatId: 'c1',
        subChatId: 'aba-error',
        assistantMessageId: 'a1',
        streamEpoch: olderEpoch,
        error: 'older provider failed',
        category: 'PROVIDER_ERROR',
      },
      {
        chatId: 'c1',
        subChatId: 'aba-error',
        assistantMessageId: 'a1',
        streamEpoch: olderEpoch,
        finalParts: [{ type: 'text', text: 'older partial answer' }],
      },
    );
    await vi.waitFor(() => expect(finalizeAssistantMessageLocalMock).toHaveBeenCalledOnce());

    setActiveExecution('aba-error', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });
    const newerEpoch = getExecutionStreamEpoch('aba-error', 'a1');
    if (!newerEpoch) throw new Error('replacement execution did not receive an epoch');
    recordLiveStreamStart({
      chatId: 'c1',
      subChatId: 'aba-error',
      assistantMessageId: 'a1',
      streamEpoch: newerEpoch,
    });
    finishFinalize();
    await olderError;

    expect(send).toHaveBeenCalledWith(
      'socket:error',
      expect.objectContaining({
        streamEpoch: olderEpoch,
        terminalDurability: { durability: 'committed' },
      }),
    );
    expect(getLiveStreamSeed('aba-error')).toEqual({
      streams: [expect.objectContaining({ streamEpoch: newerEpoch })],
      terminals: [expect.objectContaining({ streamEpoch: olderEpoch, status: 'error' })],
    });
  });

  it('drops every late frame from a superseded epoch instead of stamping it onto the winner', async () => {
    const send = captureBroadcasts();
    setActiveExecution('aba-run', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });
    const loserEpoch = getExecutionStreamEpoch('aba-run', 'a1');
    setActiveExecution('aba-run', new AbortController(), 1, {
      chatId: 'c1',
      assistantMessageId: 'a1',
    });
    const winnerEpoch = getExecutionStreamEpoch('aba-run', 'a1');

    sendStreamChunkDirect({ ...chunkAt('aba-run', 0, 'text-delta'), streamEpoch: loserEpoch });
    await sendExecuteCompleteDirect({
      chatId: 'c1',
      subChatId: 'aba-run',
      assistantMessageId: 'a1',
      streamEpoch: loserEpoch,
      finalParts: [{ type: 'text', text: 'loser' }],
    });
    sendStreamChunkDirect({ ...chunkAt('aba-run', 0, 'text-delta'), streamEpoch: winnerEpoch });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'socket:stream-chunk',
      expect.objectContaining({ streamEpoch: winnerEpoch }),
    );
    expect(getLiveStreamSeed('aba-run').streams[0]).toMatchObject({ streamEpoch: winnerEpoch });
  });

  /**
   * The AI SDK mints its own assistant id unless the opening chunk declares one, which leaves the
   * rendered message and the persisted row under different ids. Anything that later reaches an
   * in-flight message by its durable id — a wake burst appending to the turn that armed it —
   * misses and paints a second copy of that turn instead.
   */
  it('declares the persisted message id on the opening chunk', async () => {
    const send = captureBroadcasts();

    sendStreamChunkDirect(chunkAt('identity-a', 1, 'start'));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    const payload = send.mock.calls[0]?.[1] as { chunk: { type: string; messageId?: string } };
    expect(payload.chunk).toEqual({ type: 'start', messageId: 'a1' });
  });

  it('leaves every other chunk type untouched', async () => {
    const send = captureBroadcasts();

    sendStreamChunkDirect(chunkAt('identity-b', 1, 'text-delta'));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    const payload = send.mock.calls[0]?.[1] as { chunk: { messageId?: string } };
    expect(payload.chunk).not.toHaveProperty('messageId');
  });

  it('replaces producer indices with one main-minted epoch and monotonic cursor', async () => {
    const send = captureBroadcasts();

    sendStreamChunkDirect(chunkAt('ordered-a', 91));
    sendStreamChunkDirect(chunkAt('ordered-a', 7));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    const [first, second] = send.mock.calls.map(
      ([, payload]) => payload as { messageIndex: number; streamEpoch: string },
    );
    expect(first.messageIndex).toBe(0);
    expect(second.messageIndex).toBe(1);
    expect(first.streamEpoch).toBe(second.streamEpoch);
  });

  it('omits parts on a delta-only chunk and skips the DB write', async () => {
    const send = captureBroadcasts();

    sendStreamChunkDirect(chunkAt('cadence-a', 1));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send.mock.calls[0]?.[1]).not.toHaveProperty('parts');
    expect(upsertAssistantMessageLocalMock).not.toHaveBeenCalled();
  });

  it('keeps the 10th wire chunk delta-only and writes its snapshot to SQLite', async () => {
    const send = captureBroadcasts();

    startStream('cadence-b');
    for (let i = 1; i <= 10; i++) sendStreamChunkDirect(chunkAt('cadence-b', i));
    await vi.waitFor(() => expect(upsertAssistantMessageLocalMock).toHaveBeenCalledTimes(1));

    expect(send.mock.calls.every(([, payload]) => !('parts' in (payload as object)))).toBe(true);
    expect(upsertAssistantMessageLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      'cadence-b',
      'a1',
      [{ type: 'text', text: 'snapshot' }],
      expect.any(Number),
    );
  });

  it('checkpoints a resolved tool call without putting its snapshot on IPC', async () => {
    const send = captureBroadcasts();

    // No text-delta and well under 10 chunks — the count alone would never checkpoint, leaving a
    // one-command wake burst invisible until it finished.
    startStream('cadence-tool');
    sendStreamChunkDirect(chunkAt('cadence-tool', 3, 'tool-output-available'));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send.mock.calls[0]?.[1]).not.toHaveProperty('parts');
    await vi.waitFor(() => expect(upsertAssistantMessageLocalMock).toHaveBeenCalledTimes(1));
  });

  it('does NOT checkpoint a text-delta — the snapshot grows per delta, so that cadence is O(N²)', async () => {
    const send = captureBroadcasts();

    sendStreamChunkDirect(chunkAt('cadence-c', 1, 'text-delta'));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send.mock.calls[0]?.[1]).not.toHaveProperty('parts');
    expect(upsertAssistantMessageLocalMock).not.toHaveBeenCalled();
  });

  it('still checkpoints text edges without putting snapshots on IPC', async () => {
    const send = captureBroadcasts();

    startStream('cadence-d');
    sendStreamChunkDirect(chunkAt('cadence-d', 1, 'text-end'));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send.mock.calls[0]?.[1]).not.toHaveProperty('parts');
    await vi.waitFor(() => expect(upsertAssistantMessageLocalMock).toHaveBeenCalledTimes(1));
  });

  // With text-delta out of the semantic set, the every-10th counter is the ONLY thing keeping a
  // long prose run durable and observer-visible mid-stream. Pin that it still fires.
  it('a pure text-delta run checkpoints on the 10th delta and not before', async () => {
    const send = captureBroadcasts();

    startStream('cadence-prose');
    for (let i = 1; i <= 10; i++) sendStreamChunkDirect(chunkAt('cadence-prose', i, 'text-delta'));
    await vi.waitFor(() => expect(upsertAssistantMessageLocalMock).toHaveBeenCalledTimes(1));

    expect(send.mock.calls.every(([, payload]) => !('parts' in (payload as object)))).toBe(true);
    expect(send.mock.calls.length).toBe(10);
  });
});

/**
 * Delivery ownership no longer changes the local wire shape. Every window reduces the ordered
 * delta stream; ownership only tells a foreground transport whether the observer hook should paint.
 */
describe('stream chunk ownership gating', () => {
  const twoWindows = () => {
    const ownerSend = vi.fn();
    const observerSend = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      { isDestroyed: () => false, webContents: { isCrashed: () => false, id: 1, send: ownerSend } },
      {
        isDestroyed: () => false,
        webContents: { isCrashed: () => false, id: 2, send: observerSend },
      },
    ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
    return { ownerSend, observerSend };
  };

  const checkpointChunk = (subChatId: string) => ({
    chatId: 'c1',
    subChatId,
    assistantMessageId: 'a1',
    chunk: { type: 'tool-output-available' } as never,
    parts: [{ type: 'text', text: 'snapshot' }] as never,
    messageIndex: 1,
  });

  // A spy, not a module mock: vitest.setup.ts already replaces sentry/init with noops, so this only
  // records what a refused write reported.
  let captureMainMessage: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    upsertAssistantMessageLocalMock.mockClear();
    finalizeAssistantMessageLocalMock.mockClear();
    captureMainMessage = vi.spyOn(sentry, 'captureMainMessage');
    _clearActiveExecutionsForTests();
    _clearLiveStreamRegistryForTests();
  });

  afterEach(() => {
    captureMainMessage.mockRestore();
  });

  it('sends both owner and observer the same delta-only checkpoint frame', async () => {
    const { ownerSend, observerSend } = twoWindows();
    setActiveExecution('owned-run', new AbortController(), 1);
    startStream('owned-run');

    sendStreamChunkDirect(checkpointChunk('owned-run'));
    await vi.waitFor(() => expect(ownerSend).toHaveBeenCalled());

    expect(ownerSend.mock.calls[0]?.[1]).not.toHaveProperty('parts');
    expect(observerSend.mock.calls[0]?.[1]).not.toHaveProperty('parts');
  });

  it('still writes the SQLite checkpoint when the owner wire payload carried no parts', async () => {
    twoWindows();
    setActiveExecution('owned-run-db', new AbortController(), 1);
    startStream('owned-run-db');

    sendStreamChunkDirect(checkpointChunk('owned-run-db'));

    await vi.waitFor(() => expect(upsertAssistantMessageLocalMock).toHaveBeenCalledTimes(1));
    expect(upsertAssistantMessageLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      'owned-run-db',
      'a1',
      [{ type: 'text', text: 'snapshot' }],
      expect.any(Number),
    );
  });

  it('sends deltas to every window for an ownerless run (wake bursts, main-initiated)', async () => {
    const { ownerSend, observerSend } = twoWindows();
    startStream('ownerless-run');

    sendStreamChunkDirect(checkpointChunk('ownerless-run'));
    await vi.waitFor(() => expect(ownerSend).toHaveBeenCalled());

    expect(ownerSend.mock.calls[0]?.[1]).not.toHaveProperty('parts');
    expect(observerSend.mock.calls[0]?.[1]).not.toHaveProperty('parts');
  });

  it('keeps a former owner on deltas after ownership is released', async () => {
    const { ownerSend } = twoWindows();
    setActiveExecution('released-run', new AbortController(), 1);
    releaseExecutionOwnershipForWebContents(1);
    startStream('released-run');

    sendStreamChunkDirect(checkpointChunk('released-run'));
    await vi.waitFor(() => expect(ownerSend).toHaveBeenCalled());

    expect(ownerSend.mock.calls[0]?.[1]).not.toHaveProperty('parts');
  });

  // Multi-pane concurrency: two windows each own a different concurrent run. Ownership must be
  // per-run, not per-window — each window is delta-only for ITS run and an observer of the other.
  it('isolates ownership across two concurrent runs owned by different windows', async () => {
    const { ownerSend, observerSend } = twoWindows();
    setActiveExecution('run-a', new AbortController(), 1);
    setActiveExecution('run-b', new AbortController(), 2);
    startStream('run-a');
    startStream('run-b');

    sendStreamChunkDirect(checkpointChunk('run-a'));
    sendStreamChunkDirect(checkpointChunk('run-b'));
    await vi.waitFor(() => expect(ownerSend).toHaveBeenCalledTimes(2));

    const [w1RunA, w1RunB] = ownerSend.mock.calls.map(([, p]) => p as object);
    const [w2RunA, w2RunB] = observerSend.mock.calls.map(([, p]) => p as object);
    expect(w1RunA).not.toHaveProperty('parts');
    expect(w1RunB).not.toHaveProperty('parts');
    expect(w2RunA).not.toHaveProperty('parts');
    expect(w2RunB).not.toHaveProperty('parts');
  });

  // Turn end deletes the execution record. Ownership must die with it, or a later wake burst on
  // the same sub-chat (always ownerless) would be starved of the snapshots the observer lane
  // paints from — the transcript would freeze exactly when the agent works in the background.
  it('a wake burst after the owning turn ended gets deltas in every window', async () => {
    const { ownerSend, observerSend } = twoWindows();
    setActiveExecution('burst-run', new AbortController(), 1);
    const { deleteActiveExecution } = await import('./streaming/execution-registry');
    deleteActiveExecution('burst-run');
    startStream('burst-run');

    sendStreamChunkDirect(checkpointChunk('burst-run'));
    await vi.waitFor(() => expect(ownerSend).toHaveBeenCalled());

    expect(ownerSend.mock.calls[0]?.[1]).not.toHaveProperty('parts');
    expect(observerSend.mock.calls[0]?.[1]).not.toHaveProperty('parts');
  });

  // A fence-less run cannot prove its transcript: its checkpoint is refused, still broadcast to
  // every window, and reported, with the lazy Sentry import settled inside the test.
  it('refuses and reports a fence-less checkpoint while still broadcasting the delta', async () => {
    const { ownerSend, observerSend } = twoWindows();

    sendStreamChunkDirect(checkpointChunk('unfenced-run'));

    await vi.waitFor(() =>
      expect(captureMainMessage).toHaveBeenCalledWith(
        'live-stream write skipped: no fence for this epoch',
        'error',
        { surface: 'live-stream-fence', stage: 'checkpoint' },
      ),
    );
    expect(upsertAssistantMessageLocalMock).not.toHaveBeenCalled();
    expect(ownerSend).toHaveBeenCalledWith(
      'socket:stream-chunk',
      expect.objectContaining({ subChatId: 'unfenced-run' }),
    );
    expect(observerSend).toHaveBeenCalledWith(
      'socket:stream-chunk',
      expect.objectContaining({ subChatId: 'unfenced-run' }),
    );
  });

  // Fences are keyed per run: a concurrent fence-less run must neither borrow a sibling's fence
  // nor block the sibling's checkpoint.
  it('checkpoints only the fenced run when a fence-less run streams concurrently', async () => {
    twoWindows();
    startStream('fenced-sibling');

    sendStreamChunkDirect(checkpointChunk('unfenced-sibling'));
    sendStreamChunkDirect(checkpointChunk('fenced-sibling'));

    await vi.waitFor(() => expect(captureMainMessage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(upsertAssistantMessageLocalMock).toHaveBeenCalledTimes(1));
    expect(upsertAssistantMessageLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      'fenced-sibling',
      'a1',
      expect.anything(),
      expect.any(Number),
    );
  });

  // A fence registered for an older assistant message must not cover a newer message on the
  // same sub-chat: the generation lookup is per message, not per sub-chat.
  it('does not treat a fence for another assistant message as covering this one', async () => {
    twoWindows();
    startStream('reused-sub-chat');

    sendStreamChunkDirect({ ...checkpointChunk('reused-sub-chat'), assistantMessageId: 'a2' });

    await vi.waitFor(() => expect(captureMainMessage).toHaveBeenCalledTimes(1));
    expect(upsertAssistantMessageLocalMock).not.toHaveBeenCalled();
  });

  // Same-tick lazy Sentry imports: Vitest mocks only one, the rest reject. A failed telemetry
  // import must never raise an unhandled rejection or drop a broadcast.
  it('swallows failed Sentry imports from a fence-less checkpoint burst', async () => {
    const { ownerSend } = twoWindows();

    for (let i = 1; i <= 3; i++) {
      sendStreamChunkDirect({ ...checkpointChunk('unfenced-burst'), messageIndex: i });
    }

    await vi.waitFor(() => expect(captureMainMessage).toHaveBeenCalled());
    await vi.dynamicImportSettled();
    expect(ownerSend).toHaveBeenCalledTimes(3);
    expect(upsertAssistantMessageLocalMock).not.toHaveBeenCalled();
  });

  // Completion for a run that never registered a fence has no epoch to finalize: it must resolve
  // without touching SQLite rather than write a transcript it cannot attribute.
  it('resolves a fence-less completion without finalizing into SQLite', async () => {
    twoWindows();

    await expect(
      sendExecuteCompleteDirect({
        chatId: 'c1',
        subChatId: 'unfenced-complete',
        assistantMessageId: 'a1',
        finalParts: [{ type: 'text', text: 'answer' }],
      }),
    ).resolves.toBeUndefined();

    expect(finalizeAssistantMessageLocalMock).not.toHaveBeenCalled();
  });
});
