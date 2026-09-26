import type { UIMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStreamReconciler, type LocalStreamSeedResult } from './index';

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/electron/renderer', () => ({ captureException }));

const emptySeed = (): LocalStreamSeedResult => ({ streams: [], terminals: [] });

const chunk = (
  streamEpoch: string,
  messageIndex: number,
  delta: string,
  assistantMessageId = 'assistant-1',
) => ({
  chatId: 'chat-1',
  subChatId: 'sub-1',
  assistantMessageId,
  streamEpoch,
  messageIndex,
  chunk: { type: 'text-delta', delta },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('LocalStreamReconciler', () => {
  beforeEach(() => captureException.mockReset());

  it('buffers listener-first deltas and resumes from the bounded main-process seed', async () => {
    const seed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({ fetchSeed: () => seed.promise, publish });

    const hydration = reconciler.hydrate();
    reconciler.observeChunk(chunk('epoch-1', 1, 'b'));
    seed.resolve({
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'epoch-1',
          messageIndex: 0,
          parts: [{ type: 'text', text: 'a' }],
          textOpen: true,
          status: 'active',
          observerOwned: true,
        },
      ],
      terminals: [],
    });
    await hydration;

    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'ab' }],
      'streaming',
    );
  });

  it('clears an overflowed preseed buffer and reseeds once after hydration completes', async () => {
    const initialSeed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const fetchSeed = vi
      .fn<() => Promise<LocalStreamSeedResult>>()
      .mockImplementationOnce(() => initialSeed.promise)
      .mockResolvedValueOnce({
        streams: [
          {
            chatId: 'chat-1',
            subChatId: 'sub-1',
            assistantMessageId: 'assistant-1',
            streamEpoch: 'epoch-1',
            messageIndex: 1,
            parts: [{ type: 'text', text: 'ab' }],
            textOpen: true,
            status: 'active',
            observerOwned: true,
          },
        ],
        terminals: [],
      });
    const reconciler = new LocalStreamReconciler({
      fetchSeed,
      publish,
      preseedChunkLimit: 2,
    });

    const hydration = reconciler.hydrate();
    // Overflows the 2-chunk preseed buffer: the whole buffer is cleared rather than dropping
    // only the oldest entry, which would manufacture a permanent gap at the stream's start.
    reconciler.observeChunk(chunk('epoch-1', 1, 'b'));
    reconciler.observeChunk(chunk('epoch-1', 2, 'c'));
    reconciler.observeChunk(chunk('epoch-1', 3, 'd'));
    initialSeed.resolve({
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'epoch-1',
          messageIndex: 0,
          parts: [{ type: 'text', text: 'a' }],
          textOpen: true,
          status: 'active',
          observerOwned: true,
        },
      ],
      terminals: [],
    });
    await hydration;

    expect(fetchSeed).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'ab' }],
      'streaming',
    );

    // The stream keeps advancing normally from the fresh cursor after the overflow reseed.
    reconciler.observeChunk(chunk('epoch-1', 2, 'c'));
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'abc' }],
      'streaming',
    );
  });

  it('retries initial hydration instead of silently accepting an empty recovery seed', async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const fetchSeed = vi
        .fn<() => Promise<LocalStreamSeedResult>>()
        .mockRejectedValueOnce(new Error('transient initial failure'))
        .mockResolvedValueOnce({
          streams: [
            {
              chatId: 'chat-1',
              subChatId: 'sub-1',
              assistantMessageId: 'assistant-1',
              streamEpoch: 'epoch-1',
              messageIndex: 0,
              parts: [{ type: 'text', text: 'a' }],
              textOpen: true,
              status: 'active',
              observerOwned: true,
            },
          ],
          terminals: [],
        });
      const reconciler = new LocalStreamReconciler({
        fetchSeed,
        publish,
        initialHydrationRetryDelayMs: 5,
      });

      const hydration = reconciler.hydrate();
      reconciler.observeChunk(chunk('epoch-1', 1, 'b'));
      await Promise.resolve();
      expect(fetchSeed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5);
      await hydration;

      expect(fetchSeed).toHaveBeenCalledTimes(2);
      expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { surface: 'local-stream-reconcile', phase: 'initial-hydration' },
      });
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenLastCalledWith(
        'assistant-1',
        [{ type: 'text', text: 'ab' }],
        'streaming',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late delta from an epoch that already terminated', async () => {
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({
      fetchSeed: async () => emptySeed(),
      publish,
    });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('old-epoch', 0, 'old'));
    reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'old-epoch',
      continuesWakeHold: false,
      observerOwned: true,
    });
    reconciler.observeChunk(chunk('new-epoch', 0, 'new'));
    reconciler.observeChunk(chunk('old-epoch', 1, ' late'));

    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'new' }],
      'streaming',
    );
  });

  it('replaces a reused message epoch before the loser terminates and fences late loser events', async () => {
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({
      fetchSeed: async () => emptySeed(),
      publish,
    });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('loser-epoch', 0, 'loser'));
    reconciler.observeChunk(chunk('winner-epoch', 0, 'winner'));
    reconciler.observeChunk(chunk('loser-epoch', 1, ' resurrected'));
    const loserCompleted = reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'loser-epoch',
      finalParts: [{ type: 'text', text: 'loser final' }],
      continuesWakeHold: false,
      observerOwned: true,
    });
    reconciler.observeChunk(chunk('winner-epoch', 1, ' retained'));

    expect(loserCompleted).toBe(false);
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'winner retained' }],
      'streaming',
    );
    expect(publish).not.toHaveBeenCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'loser final' }],
      'ready',
    );
  });

  it('lets a zero-chunk completion replace a reused message epoch and retire the loser', async () => {
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({
      fetchSeed: async () => emptySeed(),
      publish,
    });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('loser-epoch', 0, 'loser'));
    const winnerCompleted = reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'winner-epoch',
      finalParts: [{ type: 'text', text: 'winner final' }],
      continuesWakeHold: false,
      observerOwned: true,
    });
    reconciler.observeChunk(chunk('loser-epoch', 1, ' resurrected'));

    expect(winnerCompleted).toBe(true);
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'winner final' }],
      'ready',
    );
  });

  it('does not resurrect a superseded epoch when its in-flight gap seed resolves late', async () => {
    const staleGapSeed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const fetchSeed = vi
      .fn<() => Promise<LocalStreamSeedResult>>()
      .mockResolvedValueOnce(emptySeed())
      .mockImplementationOnce(() => staleGapSeed.promise);
    const reconciler = new LocalStreamReconciler({ fetchSeed, publish });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('loser-epoch', 0, 'loser'));
    reconciler.observeChunk(chunk('loser-epoch', 2, ' gap'));
    await vi.waitFor(() => expect(fetchSeed).toHaveBeenCalledTimes(2));
    reconciler.observeChunk(chunk('winner-epoch', 0, 'winner'));
    staleGapSeed.resolve({
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'loser-epoch',
          messageIndex: 1,
          parts: [{ type: 'text', text: 'loser repaired' }],
          textOpen: true,
          status: 'active',
          observerOwned: true,
        },
      ],
      terminals: [],
    });
    await staleGapSeed.promise;
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        'assistant-1',
        [{ type: 'text', text: 'winner' }],
        'streaming',
      ),
    );

    reconciler.observeChunk(chunk('loser-epoch', 3, ' late'));
    reconciler.observeChunk(chunk('winner-epoch', 1, ' retained'));
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'winner retained' }],
      'streaming',
    );
  });

  it('repairs a gap only from its exact epoch when the seed retains older records', async () => {
    const gapSeed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const onEpochSuperseded = vi.fn();
    const fetchSeed = vi
      .fn<() => Promise<LocalStreamSeedResult>>()
      .mockResolvedValueOnce(emptySeed())
      .mockImplementationOnce(() => gapSeed.promise);
    const reconciler = new LocalStreamReconciler({ fetchSeed, publish, onEpochSuperseded });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('current-epoch', 0, 'a'));
    reconciler.observeChunk(chunk('current-epoch', 2, 'c'));
    await vi.waitFor(() => expect(fetchSeed).toHaveBeenCalledTimes(2));
    gapSeed.resolve({
      terminals: [
        {
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'older-terminal',
          status: 'settled',
          durability: 'committed',
        },
      ],
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'older-settling',
          messageIndex: 4,
          parts: [],
          textOpen: false,
          status: 'settling',
          observerOwned: true,
        },
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'current-epoch',
          messageIndex: 1,
          parts: [{ type: 'text', text: 'ab' }],
          textOpen: true,
          status: 'active',
          observerOwned: true,
        },
      ],
    });

    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        'assistant-1',
        [{ type: 'text', text: 'abc' }],
        'streaming',
      ),
    );
    expect(onEpochSuperseded).not.toHaveBeenCalledWith('current-epoch');

    reconciler.observeChunk(chunk('current-epoch', 3, 'd'));
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'abcd' }],
      'streaming',
    );
  });

  it('deduplicates cursors and performs one bounded reseed for a gap', async () => {
    const publish = vi.fn();
    const fetchSeed = vi
      .fn<() => Promise<LocalStreamSeedResult>>()
      .mockResolvedValueOnce(emptySeed())
      .mockResolvedValueOnce({
        streams: [
          {
            chatId: 'chat-1',
            subChatId: 'sub-1',
            assistantMessageId: 'assistant-1',
            streamEpoch: 'epoch-1',
            messageIndex: 1,
            parts: [{ type: 'text', text: 'ab' }],
            textOpen: true,
            status: 'active',
            observerOwned: true,
          },
        ],
        terminals: [],
      });
    const reconciler = new LocalStreamReconciler({ fetchSeed, publish });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('epoch-1', 0, 'a'));
    reconciler.observeChunk(chunk('epoch-1', 0, 'duplicate'));
    reconciler.observeChunk(chunk('epoch-1', 2, 'c'));
    await vi.waitFor(() => expect(fetchSeed).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        'assistant-1',
        [{ type: 'text', text: 'abc' }],
        'streaming',
      ),
    );
  });

  it('bounds each epoch gap buffer and repairs evicted cursors with a later seed', async () => {
    const firstGapSeed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const fetchSeed = vi
      .fn<() => Promise<LocalStreamSeedResult>>()
      .mockResolvedValueOnce(emptySeed())
      .mockImplementationOnce(() => firstGapSeed.promise)
      .mockResolvedValueOnce({
        streams: [
          {
            chatId: 'chat-1',
            subChatId: 'sub-1',
            assistantMessageId: 'assistant-1',
            streamEpoch: 'epoch-1',
            messageIndex: 2,
            parts: [{ type: 'text', text: 'abc' }],
            textOpen: true,
            status: 'active',
            observerOwned: true,
          },
        ],
        terminals: [],
      });
    const reconciler = new LocalStreamReconciler({
      fetchSeed,
      publish,
      gapBufferLimit: 2,
    });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('epoch-1', 0, 'a'));
    reconciler.observeChunk(chunk('epoch-1', 2, 'c'));
    reconciler.observeChunk(chunk('epoch-1', 3, 'd'));
    reconciler.observeChunk(chunk('epoch-1', 4, 'e'));
    firstGapSeed.resolve({
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'epoch-1',
          messageIndex: 1,
          parts: [{ type: 'text', text: 'ab' }],
          textOpen: true,
          status: 'active',
          observerOwned: true,
        },
      ],
      terminals: [],
    });

    await vi.waitFor(() => expect(fetchSeed).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        'assistant-1',
        [{ type: 'text', text: 'abcde' }],
        'streaming',
      ),
    );
  });

  it('retries a gap once immediately after a failed seed pull, then repairs it', async () => {
    const publish = vi.fn();
    const fetchSeed = vi
      .fn<() => Promise<LocalStreamSeedResult>>()
      .mockResolvedValueOnce(emptySeed())
      .mockRejectedValueOnce(new Error('transient seed failure'))
      .mockResolvedValueOnce({
        streams: [
          {
            chatId: 'chat-1',
            subChatId: 'sub-1',
            assistantMessageId: 'assistant-1',
            streamEpoch: 'epoch-1',
            messageIndex: 1,
            parts: [{ type: 'text', text: 'ab' }],
            textOpen: true,
            status: 'active',
            observerOwned: true,
          },
        ],
        terminals: [],
      });
    const reconciler = new LocalStreamReconciler({ fetchSeed, publish });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('epoch-1', 0, 'a'));
    reconciler.observeChunk(chunk('epoch-1', 2, 'c'));

    // Local IPC is ordered and reliable, so recovery is immediate reseed + one retry — no
    // backoff ladder or fake timers needed to observe it settle.
    await vi.waitFor(() => expect(fetchSeed).toHaveBeenCalledTimes(3));
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: 'local-stream-reconcile', phase: 'gap-repair' },
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'abc' }],
      'streaming',
    );
    reconciler.dispose();
  });

  it('gives up after one retry instead of looping the gap indefinitely', async () => {
    const publish = vi.fn();
    const fetchSeed = vi
      .fn<() => Promise<LocalStreamSeedResult>>()
      .mockResolvedValueOnce(emptySeed())
      .mockResolvedValueOnce(emptySeed())
      .mockResolvedValueOnce(emptySeed());
    const reconciler = new LocalStreamReconciler({ fetchSeed, publish });
    await reconciler.hydrate();

    reconciler.observeChunk(chunk('epoch-1', 0, 'a'));
    reconciler.observeChunk(chunk('epoch-1', 2, 'c'));

    await vi.waitFor(() => expect(fetchSeed).toHaveBeenCalledTimes(3));
    expect(captureException).toHaveBeenCalledTimes(1);

    // Nothing schedules a further attempt once the single retry is spent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSeed).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'a' }],
      'streaming',
    );
    reconciler.dispose();
  });

  it('lets a terminal push dominate a stale seed response', async () => {
    const seed = deferred<LocalStreamSeedResult>();
    const publish =
      vi.fn<(id: string, parts: UIMessage['parts'], status: 'streaming' | 'ready') => void>();
    const reconciler = new LocalStreamReconciler({ fetchSeed: () => seed.promise, publish });

    const hydration = reconciler.hydrate();
    reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      continuesWakeHold: false,
      observerOwned: true,
    });
    seed.resolve({
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'epoch-1',
          messageIndex: 4,
          parts: [{ type: 'text', text: 'stale' }],
          textOpen: false,
          status: 'active',
          observerOwned: true,
        },
      ],
      terminals: [],
    });
    await hydration;

    expect(publish).not.toHaveBeenCalled();
  });

  it('applies a still-owned zero-chunk completion after its initial seed resolves', async () => {
    const seed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({ fetchSeed: () => seed.promise, publish });

    const hydration = reconciler.hydrate();
    const publishedImmediately = reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      finalParts: [{ type: 'text', text: 'listener final' }],
      continuesWakeHold: false,
      observerOwned: false,
    });
    seed.resolve({
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'epoch-1',
          messageIndex: -1,
          parts: [{ type: 'text', text: 'stale seed' }],
          textOpen: false,
          status: 'settling',
          observerOwned: false,
        },
      ],
      terminals: [],
    });
    await hydration;

    expect(publishedImmediately).toBe(false);
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'listener final' }],
      'ready',
    );
  });

  it('lets settlement retire a deferred held completion before the initial seed resolves', async () => {
    const seed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({ fetchSeed: () => seed.promise, publish });

    const hydration = reconciler.hydrate();
    reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      finalParts: [{ type: 'text', text: 'listener final' }],
      continuesWakeHold: true,
      observerOwned: false,
    });
    reconciler.settle('assistant-1', 'epoch-1');
    seed.resolve(emptySeed());
    await hydration;

    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'listener final' }],
      'ready',
    );
    publish.mockClear();
    reconciler.observeChunk(chunk('epoch-1', 0, 'resurrected'));
    expect(publish).not.toHaveBeenCalled();
  });

  it('lets a terminal seed retire a deferred held completion without reviving it', async () => {
    const seed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({ fetchSeed: () => seed.promise, publish });

    const hydration = reconciler.hydrate();
    reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      finalParts: [{ type: 'text', text: 'listener final' }],
      continuesWakeHold: true,
      observerOwned: false,
    });
    seed.resolve({
      streams: [],
      terminals: [
        {
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'epoch-1',
          status: 'settled',
          durability: 'committed',
        },
      ],
    });
    await hydration;

    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'listener final' }],
      'ready',
    );
    publish.mockClear();
    reconciler.observeChunk(chunk('epoch-1', 0, 'resurrected'));
    expect(publish).not.toHaveBeenCalled();
  });

  it('retries a stale empty initial seed before releasing a deferred completion', async () => {
    const staleSeed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const fetchSeed = vi
      .fn<() => Promise<LocalStreamSeedResult>>()
      .mockImplementationOnce(() => staleSeed.promise)
      .mockResolvedValueOnce({
        streams: [],
        terminals: [
          {
            subChatId: 'sub-1',
            assistantMessageId: 'assistant-1',
            streamEpoch: 'epoch-1',
            status: 'settled',
            durability: 'committed',
          },
        ],
      });
    const reconciler = new LocalStreamReconciler({
      fetchSeed,
      publish,
      initialHydrationRetryDelayMs: 0,
    });

    const hydration = reconciler.hydrate();
    reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      finalParts: [{ type: 'text', text: 'listener final' }],
      continuesWakeHold: false,
      observerOwned: false,
    });
    staleSeed.resolve(emptySeed());
    await hydration;

    expect(fetchSeed).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'listener final' }],
      'ready',
    );
  });

  it('does not resurrect a buffered chunk after its terminal arrives during hydration', async () => {
    const seed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({ fetchSeed: () => seed.promise, publish });

    const hydration = reconciler.hydrate();
    reconciler.observeChunk(chunk('epoch-1', 0, 'buffered'));
    reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      continuesWakeHold: false,
      observerOwned: false,
    });
    seed.resolve(emptySeed());
    await hydration;

    expect(publish).not.toHaveBeenCalled();
  });

  it('lets a held completion dominate an older active seed without retiring the epoch', async () => {
    const seed = deferred<LocalStreamSeedResult>();
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({ fetchSeed: () => seed.promise, publish });

    const hydration = reconciler.hydrate();
    reconciler.complete({
      assistantMessageId: 'assistant-1',
      streamEpoch: 'epoch-1',
      finalParts: [{ type: 'text', text: 'held final' }],
      continuesWakeHold: true,
      observerOwned: true,
    });
    seed.resolve({
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'epoch-1',
          messageIndex: 3,
          parts: [{ type: 'text', text: 'stale active' }],
          textOpen: false,
          status: 'active',
          observerOwned: true,
        },
      ],
      terminals: [],
    });
    await hydration;

    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'held final' }],
      'ready',
    );
  });

  it('publishes a settling seed as ready when post-finalize settlement arrives', async () => {
    const publish = vi.fn();
    const reconciler = new LocalStreamReconciler({
      fetchSeed: async () => ({
        streams: [
          {
            chatId: 'chat-1',
            subChatId: 'sub-1',
            assistantMessageId: 'assistant-1',
            streamEpoch: 'epoch-1',
            messageIndex: 4,
            parts: [{ type: 'text', text: 'final' }],
            textOpen: false,
            status: 'settling',
            observerOwned: true,
          },
        ],
        terminals: [],
      }),
      publish,
    });
    await reconciler.hydrate();

    reconciler.settle('assistant-1', 'epoch-1');

    expect(publish).toHaveBeenLastCalledWith(
      'assistant-1',
      [{ type: 'text', text: 'final' }],
      'ready',
    );
  });
});
