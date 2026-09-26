// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetLiveRunHydrationForTests,
  isLiveRunHydrationComplete,
} from '../../../../lib/stores/renderer-recovery-ready';
import { useLiveRunSync } from './index';

type EpochEvent = {
  chatId?: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch?: string;
  continuesWakeHold?: boolean;
  chunk?: unknown;
};

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  appStoreSet: vi.fn(),
  setStatus: vi.fn(),
  listHeaders: vi.fn(),
  listPendingQuestionIds: vi.fn(),
  getSeed: vi.fn(),
  applyQuestionChunk: vi.fn(),
  hasActiveTransport: vi.fn(() => false),
  order: [] as string[],
}));

vi.mock('@sentry/electron/renderer', () => ({ captureException: mocks.captureException }));

let executeStartHandler: ((payload: EpochEvent) => void) | null = null;
let streamChunkHandler: ((payload: EpochEvent) => void) | null = null;
let completeHandler: ((payload: EpochEvent) => void) | null = null;
let settledHandler: ((payload: EpochEvent) => void) | null = null;

vi.mock('../../../../lib/jotai-store', () => ({
  appStore: { set: (...args: unknown[]) => mocks.appStoreSet(...args) },
}));

vi.mock('../../../../lib/trpc', () => ({
  trpcClient: {
    socket: {
      listLiveStreamHeaders: {
        query: () => {
          mocks.order.push('query');
          return mocks.listHeaders();
        },
      },
      listPendingQuestionSubChatIds: {
        query: () => mocks.listPendingQuestionIds(),
      },
      getLiveStreamSeed: {
        query: (input: { subChatId: string }) => mocks.getSeed(input),
      },
    },
  },
}));

vi.mock('../../../../lib/utils/platform', () => ({ isDesktopApp: () => true }));
vi.mock('../../lib/ask-user-question-chunks', () => ({
  applyAskUserQuestionChunk: (input: unknown) => mocks.applyQuestionChunk(input),
}));
vi.mock('../../stores/streaming-status-store', () => ({
  useStreamingStatusStore: { getState: () => ({ setStatus: mocks.setStatus }) },
}));
vi.mock('../../../../lib/stores/active-transport-registry', () => ({
  hasActiveTransport: () => mocks.hasActiveTransport(),
  observedRunAtomFamily: (subChatId: string) => `observed:${subChatId}`,
  runLiveAtomFamily: (subChatId: string) => `runLive:${subChatId}`,
  runSettlingAtomFamily: (subChatId: string) => `settling:${subChatId}`,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function installDesktopApi(): void {
  executeStartHandler = null;
  streamChunkHandler = null;
  completeHandler = null;
  settledHandler = null;
  (window as unknown as { desktopApi: unknown }).desktopApi = {
    onSocketExecuteStart: (handler: (payload: EpochEvent) => void) => {
      mocks.order.push('listen:start');
      executeStartHandler = handler;
      return vi.fn();
    },
    onSocketStreamChunk: (handler: (payload: EpochEvent) => void) => {
      mocks.order.push('listen:chunk');
      streamChunkHandler = handler;
      return vi.fn();
    },
    onSocketExecuteComplete: (handler: (payload: EpochEvent) => void) => {
      mocks.order.push('listen:complete');
      completeHandler = handler;
      return vi.fn();
    },
    onSocketError: () => {
      mocks.order.push('listen:error');
      return vi.fn();
    },
    on: (channel: string, handler: (payload: EpochEvent) => void) => {
      expect(channel).toBe('socket:stream-settled');
      mocks.order.push('listen:settled');
      settledHandler = handler;
      return vi.fn();
    },
  };
}

describe('useLiveRunSync', () => {
  beforeEach(() => {
    _resetLiveRunHydrationForTests();
    mocks.appStoreSet.mockReset();
    mocks.captureException.mockReset();
    mocks.setStatus.mockReset();
    mocks.listHeaders.mockReset();
    mocks.listPendingQuestionIds.mockReset();
    mocks.listPendingQuestionIds.mockResolvedValue([]);
    mocks.getSeed.mockReset();
    mocks.getSeed.mockResolvedValue({
      streams: [{ streamEpoch: 'epoch-1' }],
      terminals: [],
      pendingQuestions: [],
    });
    mocks.applyQuestionChunk.mockReset();
    mocks.hasActiveTransport.mockReset();
    mocks.hasActiveTransport.mockReturnValue(false);
    mocks.order.length = 0;
    installDesktopApi();
  });

  it('publishes run liveness but leaves status to a transport this window owns', async () => {
    mocks.listHeaders.mockResolvedValue([]);
    mocks.hasActiveTransport.mockReturnValue(true);
    const hook = renderHook(() => useLiveRunSync());
    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));
    mocks.setStatus.mockClear();

    executeStartHandler?.({ subChatId: 'sub-own', assistantMessageId: 'assistant-own' });

    // The turn's own transport writes the presentation status; a lane-side 'ready' at its next
    // publish would otherwise read as the turn ending while the transport still streams.
    expect(mocks.appStoreSet).toHaveBeenCalledWith('runLive:sub-own', true);
    expect(mocks.appStoreSet).toHaveBeenCalledWith('observed:sub-own', false);
    expect(mocks.setStatus).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('publishes settling from a completed turn until it settles or another turn starts', async () => {
    mocks.listHeaders.mockResolvedValue([]);
    const hook = renderHook(() => useLiveRunSync());
    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));
    const settling = () =>
      mocks.appStoreSet.mock.calls.filter(([atom]) => atom === 'settling:sub-1').at(-1)?.[1];
    const first = { subChatId: 'sub-1', assistantMessageId: 'assistant-1', streamEpoch: 'epoch-1' };
    const second = { ...first, assistantMessageId: 'assistant-2', streamEpoch: 'epoch-2' };

    streamChunkHandler?.(first); // mid-turn, even with no stream open in this window
    expect(settling()).toBe(false);
    completeHandler?.(first);
    expect(settling()).toBe(true);
    settledHandler?.(first);
    expect(settling()).toBe(false);

    streamChunkHandler?.(second);
    completeHandler?.(second);
    expect(settling()).toBe(true);
    executeStartHandler?.({ subChatId: 'sub-1', assistantMessageId: 'assistant-3' });
    expect(settling()).toBe(false);
    hook.unmount();
  });

  it('installs terminal listeners before pulling headers and ignores a stale header', async () => {
    const headers = deferred<EpochEvent[]>();
    mocks.listHeaders.mockReturnValue(headers.promise);
    const hook = renderHook(() => useLiveRunSync());

    expect(mocks.order).toEqual([
      'listen:start',
      'listen:chunk',
      'listen:complete',
      'listen:error',
      'listen:settled',
      'query',
    ]);
    expect(isLiveRunHydrationComplete()).toBe(false);

    settledHandler?.({
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
    });
    headers.resolve([
      {
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
      },
    ]);

    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));
    expect(mocks.appStoreSet).toHaveBeenLastCalledWith('observed:sub-1', false);
    expect(mocks.setStatus).toHaveBeenLastCalledWith('sub-1', 'ready');
    hook.unmount();
  });

  it('reports header hydration failure once while retaining the recovery barrier', async () => {
    const failure = new Error('header hydration failed');
    mocks.listHeaders.mockRejectedValue(failure);
    const hook = renderHook(() => useLiveRunSync());

    await waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(failure, {
        tags: { surface: 'live-run-rehydrate', phase: 'header-hydration' },
      }),
    );
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(isLiveRunHydrationComplete()).toBe(false);
    hook.unmount();
  });

  it('reports seed validation failure once without blocking queue admission', async () => {
    const failure = new Error('seed validation failed');
    mocks.listHeaders.mockResolvedValue([
      {
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
      },
    ]);
    mocks.getSeed.mockRejectedValue(failure);
    const hook = renderHook(() => useLiveRunSync());

    await waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(failure, {
        tags: { surface: 'live-run-rehydrate', phase: 'seed-validation' },
      }),
    );
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    // The header pull alone opens the queue gate — seed validation is a slower, separate concern.
    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));
    hook.unmount();
  });

  it('restores main-owned liveness before opening queue admission', async () => {
    mocks.listHeaders.mockResolvedValue([
      {
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
      },
    ]);
    const hook = renderHook(() => useLiveRunSync());

    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));
    expect(mocks.appStoreSet).toHaveBeenCalledWith('observed:sub-1', true);
    expect(mocks.setStatus).toHaveBeenCalledWith('sub-1', 'streaming');
    await waitFor(() => expect(mocks.getSeed).toHaveBeenCalledWith({ subChatId: 'sub-1' }));
    hook.unmount();
  });

  it('closes queue admission for a zero-chunk execute start racing the header pull', async () => {
    const headers = deferred<EpochEvent[]>();
    mocks.listHeaders.mockReturnValue(headers.promise);
    const hook = renderHook(() => useLiveRunSync());

    executeStartHandler?.({
      subChatId: 'sub-start',
      assistantMessageId: 'assistant-start',
    });
    headers.resolve([]);

    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));
    expect(mocks.appStoreSet).toHaveBeenLastCalledWith('observed:sub-start', true);
    expect(mocks.setStatus).toHaveBeenLastCalledWith('sub-start', 'streaming');
    hook.unmount();
  });

  it('keeps recovery closed until a held unmounted sub-chat question is materialized', async () => {
    const seed = deferred<{
      streams: Array<{ streamEpoch: string }>;
      terminals: never[];
      pendingQuestions: Array<{
        chatId: string;
        subChatId: string;
        toolUseId: string;
        questions: never[];
      }>;
    }>();
    mocks.listHeaders.mockResolvedValue([]);
    mocks.listPendingQuestionIds.mockResolvedValue(['held-sub']);
    mocks.getSeed.mockReturnValue(seed.promise);
    const hook = renderHook(() => useLiveRunSync());

    await waitFor(() => expect(mocks.getSeed).toHaveBeenCalledWith({ subChatId: 'held-sub' }));
    expect(mocks.applyQuestionChunk).not.toHaveBeenCalled();

    seed.resolve({
      streams: [{ streamEpoch: 'held-epoch' }],
      terminals: [],
      pendingQuestions: [
        {
          chatId: 'chat-1',
          subChatId: 'held-sub',
          toolUseId: 'question-1',
          questions: [],
        },
      ],
    });

    await waitFor(() =>
      expect(mocks.applyQuestionChunk).toHaveBeenCalledWith({
        chunk: { type: 'ask-user-question', toolUseId: 'question-1', questions: [] },
        subChatId: 'held-sub',
        parentChatId: 'chat-1',
      }),
    );
    hook.unmount();
  });

  it('materializes pending questions from an inactive sub-chat seed', async () => {
    mocks.listHeaders.mockResolvedValue([
      {
        subChatId: 'background-sub',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
      },
    ]);
    mocks.getSeed.mockResolvedValue({
      streams: [{ streamEpoch: 'epoch-1' }],
      terminals: [],
      pendingQuestions: [
        {
          chatId: 'chat-1',
          subChatId: 'background-sub',
          toolUseId: 'question-1',
          questions: [],
        },
      ],
    });
    const hook = renderHook(() => useLiveRunSync());

    await waitFor(() =>
      expect(mocks.applyQuestionChunk).toHaveBeenCalledWith({
        chunk: { type: 'ask-user-question', toolUseId: 'question-1', questions: [] },
        subChatId: 'background-sub',
        parentChatId: 'chat-1',
      }),
    );
    hook.unmount();
  });

  it('does not resurrect a seeded question retired while the seed was in flight', async () => {
    const seed = deferred<{
      streams: Array<{ streamEpoch: string }>;
      terminals: never[];
      pendingQuestions: Array<{
        chatId: string;
        subChatId: string;
        toolUseId: string;
        questions: never[];
      }>;
    }>();
    mocks.listHeaders.mockResolvedValue([
      {
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
      },
    ]);
    mocks.getSeed.mockReturnValue(seed.promise);
    const hook = renderHook(() => useLiveRunSync());
    await waitFor(() => expect(mocks.getSeed).toHaveBeenCalled());

    streamChunkHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      chunk: { type: 'ask-user-question-result', toolUseId: 'question-1' },
    });
    for (let index = 0; index < 64; index++) {
      streamChunkHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
        chunk: { type: 'tool-output-available', toolCallId: `unrelated-${index}` },
      });
    }
    seed.resolve({
      streams: [{ streamEpoch: 'epoch-1' }],
      terminals: [],
      pendingQuestions: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          toolUseId: 'question-1',
          questions: [],
        },
      ],
    });

    await waitFor(() =>
      expect(mocks.applyQuestionChunk).toHaveBeenCalledWith(
        expect.objectContaining({
          chunk: expect.objectContaining({ type: 'ask-user-question-result' }),
        }),
      ),
    );
    expect(
      mocks.applyQuestionChunk.mock.calls.some(
        ([input]) => (input as { chunk?: { type?: string } }).chunk?.type === 'ask-user-question',
      ),
    ).toBe(false);
    hook.unmount();
  });

  it('restores a second pending question without duplicating the one already pushed live', async () => {
    const seed = deferred<{
      streams: Array<{ streamEpoch: string }>;
      terminals: never[];
      pendingQuestions: Array<{
        chatId: string;
        subChatId: string;
        toolUseId: string;
        questions: never[];
      }>;
    }>();
    mocks.listHeaders.mockResolvedValue([
      {
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
      },
    ]);
    mocks.getSeed.mockReturnValue(seed.promise);
    const hook = renderHook(() => useLiveRunSync());
    await waitFor(() => expect(mocks.getSeed).toHaveBeenCalled());

    streamChunkHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      chunk: { type: 'ask-user-question', toolUseId: 'question-1', questions: [] },
    });
    seed.resolve({
      streams: [{ streamEpoch: 'epoch-1' }],
      terminals: [],
      pendingQuestions: [
        { chatId: 'chat-1', subChatId: 'sub-1', toolUseId: 'question-1', questions: [] },
        { chatId: 'chat-1', subChatId: 'sub-1', toolUseId: 'question-2', questions: [] },
      ],
    });

    await waitFor(() =>
      expect(mocks.applyQuestionChunk).toHaveBeenLastCalledWith({
        chunk: { type: 'ask-user-question', toolUseId: 'question-2', questions: [] },
        subChatId: 'sub-1',
        parentChatId: 'chat-1',
      }),
    );
    expect(mocks.applyQuestionChunk).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('does not let unrelated tool output suppress a question from the in-flight seed', async () => {
    const seed = deferred<{
      streams: Array<{ streamEpoch: string }>;
      terminals: never[];
      pendingQuestions: Array<{
        chatId: string;
        subChatId: string;
        toolUseId: string;
        questions: never[];
      }>;
    }>();
    mocks.listHeaders.mockResolvedValue([
      {
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
      },
    ]);
    mocks.getSeed.mockReturnValue(seed.promise);
    const hook = renderHook(() => useLiveRunSync());
    await waitFor(() => expect(mocks.getSeed).toHaveBeenCalled());

    streamChunkHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      chunk: { type: 'tool-output-available', toolCallId: 'unrelated-tool' },
    });
    seed.resolve({
      streams: [{ streamEpoch: 'epoch-1' }],
      terminals: [],
      pendingQuestions: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          toolUseId: 'question-1',
          questions: [],
        },
      ],
    });

    await waitFor(() =>
      expect(mocks.applyQuestionChunk).toHaveBeenCalledWith({
        chunk: { type: 'ask-user-question', toolUseId: 'question-1', questions: [] },
        subChatId: 'sub-1',
        parentChatId: 'chat-1',
      }),
    );
    hook.unmount();
  });

  it('does not spend recovery readiness when a seed resolves after disposal', async () => {
    const seed = deferred<{
      streams: Array<{ streamEpoch: string }>;
      terminals: never[];
      pendingQuestions: Array<{
        chatId: string;
        subChatId: string;
        toolUseId: string;
        questions: never[];
      }>;
    }>();
    mocks.listHeaders.mockResolvedValue([
      {
        subChatId: 'sub-1',
        assistantMessageId: 'assistant-1',
        streamEpoch: 'epoch-1',
      },
    ]);
    mocks.getSeed.mockReturnValue(seed.promise);
    const hook = renderHook(() => useLiveRunSync());
    await waitFor(() => expect(mocks.getSeed).toHaveBeenCalled());

    hook.unmount();
    seed.resolve({
      streams: [{ streamEpoch: 'epoch-1' }],
      terminals: [],
      // A pending question here would prove the disposed-guard: if the resolved seed still
      // applied after unmount, this is the call that would fire.
      pendingQuestions: [
        { chatId: 'chat-1', subChatId: 'sub-1', toolUseId: 'question-1', questions: [] },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.applyQuestionChunk).not.toHaveBeenCalled();
  });

  it('deactivates a held epoch without tombstoning its next wake burst', async () => {
    mocks.listHeaders.mockResolvedValue([]);
    const hook = renderHook(() => useLiveRunSync());
    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));

    streamChunkHandler?.({
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
    });
    completeHandler?.({
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      continuesWakeHold: true,
    });
    streamChunkHandler?.({
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
    });

    expect(mocks.appStoreSet).toHaveBeenLastCalledWith('observed:sub-1', true);
    expect(mocks.setStatus).toHaveBeenLastCalledWith('sub-1', 'streaming');
    hook.unmount();
  });

  it('does not let a stale header clobber a presentation that already rotated to a new epoch', async () => {
    const headers = deferred<EpochEvent[]>();
    mocks.listHeaders.mockReturnValue(headers.promise);
    const hook = renderHook(() => useLiveRunSync());

    // A push for epoch-new lands while the header pull is still in flight.
    streamChunkHandler?.({
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-new',
    });
    headers.resolve([
      { subChatId: 'sub-1', assistantMessageId: 'assistant-1', streamEpoch: 'epoch-old' },
    ]);
    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));

    // The stale snapshot neither retires epoch-new nor drops its later chunks.
    mocks.setStatus.mockClear();
    streamChunkHandler?.({
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-new',
    });
    settledHandler?.({
      subChatId: 'sub-1',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-new',
    });
    expect(mocks.setStatus).toHaveBeenCalledWith('sub-1', 'streaming');
    expect(mocks.setStatus).toHaveBeenLastCalledWith('sub-1', 'ready');
    hook.unmount();
  });

  it('lets a late old terminal retire only its own epoch at the root listener', async () => {
    mocks.listHeaders.mockResolvedValue([]);
    const hook = renderHook(() => useLiveRunSync());
    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));

    streamChunkHandler?.({
      subChatId: 'aba-sub',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-old',
    });
    streamChunkHandler?.({
      subChatId: 'aba-sub',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-new',
    });
    completeHandler?.({
      subChatId: 'aba-sub',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-old',
      continuesWakeHold: true,
    });
    settledHandler?.({
      subChatId: 'aba-sub',
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-old',
    });

    // epoch-new is still live after the old epoch's completion/settlement retire only epoch-old.
    expect(mocks.appStoreSet).toHaveBeenLastCalledWith('observed:aba-sub', true);
    expect(mocks.setStatus).toHaveBeenLastCalledWith('aba-sub', 'streaming');
    hook.unmount();
  });

  it('retries the header pull until it succeeds before opening queue admission', async () => {
    const failure = new Error('transient header failure');
    mocks.listHeaders
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([]);
    const hook = renderHook(() => useLiveRunSync());

    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true), { timeout: 3000 });
    expect(mocks.listHeaders).toHaveBeenCalledTimes(3);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('does not resurrect a wake-held epoch from a header pulled before the hold', async () => {
    const headers = deferred<EpochEvent[]>();
    mocks.listHeaders.mockReturnValue(headers.promise);
    const hook = renderHook(() => useLiveRunSync());

    const event = { subChatId: 'sub-1', assistantMessageId: 'assistant-1', streamEpoch: 'epoch-1' };
    streamChunkHandler?.(event);
    completeHandler?.({ ...event, continuesWakeHold: true });
    headers.resolve([event]);
    await waitFor(() => expect(isLiveRunHydrationComplete()).toBe(true));
    expect(mocks.setStatus).toHaveBeenLastCalledWith('sub-1', 'ready');

    streamChunkHandler?.(event);
    expect(mocks.setStatus).toHaveBeenLastCalledWith('sub-1', 'streaming');
    hook.unmount();
  });
});
