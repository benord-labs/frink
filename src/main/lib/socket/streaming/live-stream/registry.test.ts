import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AssistantPartShape,
  applyAssistantChunkToParts,
  assistantPartsSnapshot,
  assistantPartsStateFromSnapshot,
} from '../../../../../shared/lib/assistant-parts';
import {
  _clearActiveExecutionsForTests,
  deleteActiveExecution,
  getExecutionStreamEpoch,
  releaseExecutionOwnershipForWebContents,
  replaceActiveExecutionController,
  setActiveExecution,
} from '../execution-registry';
import {
  _clearLiveStreamRegistryForTests,
  beginLiveStreamCompletion,
  finishHeldLiveStreams,
  getLiveStreamSeed,
  listLiveStreamHeaders,
  markLiveStreamCompletionFinalized,
  recordLiveStreamChunk,
  recordLiveStreamError,
  recordLiveStreamStart,
  releaseLiveStreamOwnershipForWebContents,
  resolveLiveStreamEpoch,
  settleLiveStreamCompletion,
} from './registry';
import { __resetSubChatLocks, bumpWriteGeneration } from '../../../db/repos/sub-chat-mutex';

describe('live stream recovery registry', () => {
  beforeEach(() => {
    _clearActiveExecutionsForTests();
    _clearLiveStreamRegistryForTests();
  });

  it('preserves the epoch when the provider controller is replaced mid-run', () => {
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const before = getExecutionStreamEpoch('sub', 'assistant');

    replaceActiveExecutionController('sub', new AbortController());

    expect(getExecutionStreamEpoch('sub', 'assistant')).toBe(before);
  });

  it('returns a bounded seed and transfers paint ownership after renderer loss', () => {
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const streamEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 3,
      parts: [{ type: 'text', text: 'partial' }],
      chunk: { type: 'text-delta', delta: 'l' },
    });

    expect(getLiveStreamSeed('sub').streams[0]).toMatchObject({
      streamEpoch,
      messageIndex: 3,
      observerOwned: false,
      textOpen: true,
      parts: [{ type: 'text', text: 'partial' }],
    });

    releaseExecutionOwnershipForWebContents(7);
    releaseLiveStreamOwnershipForWebContents(7);

    expect(getLiveStreamSeed('sub').streams[0]?.observerOwned).toBe(true);
  });

  it('uses registered zero-chunk ownership to distinguish ordinary completion from recovery', () => {
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const streamEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    deleteActiveExecution('sub');

    expect(
      beginLiveStreamCompletion({
        chatId: 'chat',
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch,
        continuesWakeHold: false,
        observerOwned: false,
      }),
    ).toBe(false);

    _clearLiveStreamRegistryForTests();
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const recoveryEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: recoveryEpoch,
    });
    releaseExecutionOwnershipForWebContents(7);
    releaseLiveStreamOwnershipForWebContents(7);

    expect(
      beginLiveStreamCompletion({
        chatId: 'chat',
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch: recoveryEpoch,
        continuesWakeHold: false,
        observerOwned: false,
      }),
    ).toBe(true);
  });

  it('makes settling visible before completion and then returns an epoch tombstone', () => {
    const streamEpoch = 'epoch';
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 0,
      parts: [{ type: 'text', text: 'done' }],
      chunk: { type: 'text-end' },
    });

    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      finalParts: [{ type: 'text', text: 'done' }],
      continuesWakeHold: false,
    });
    expect(getLiveStreamSeed('sub').streams[0]?.status).toBe('settling');

    settleLiveStreamCompletion({ subChatId: 'sub', assistantMessageId: 'assistant', streamEpoch });
    expect(getLiveStreamSeed('sub')).toEqual({
      streams: [],
      terminals: [
        {
          subChatId: 'sub',
          assistantMessageId: 'assistant',
          streamEpoch,
          status: 'settled',
          durability: 'non-durable',
          parts: [{ type: 'text', text: 'done' }],
        },
      ],
    });
  });

  it('keeps one epoch and cursor seed through wake bursts until the hold retracts', () => {
    const streamEpoch = 'wake-epoch';
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 8,
      parts: [{ type: 'text', text: 'foreground' }],
      chunk: { type: 'text-end' },
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      continuesWakeHold: true,
    });

    expect(resolveLiveStreamEpoch('sub', 'assistant')).toBe(streamEpoch);
    expect(getLiveStreamSeed('sub').streams[0]?.status).toBe('held');
    markLiveStreamCompletionFinalized({
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      terminalDurability: { durability: 'committed' },
    });
    markLiveStreamCompletionFinalized({
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      terminalDurability: { durability: 'committed' },
    });
    expect(finishHeldLiveStreams('sub')).toEqual([
      {
        assistantMessageId: 'assistant',
        streamEpoch,
        terminalDurability: { durability: 'committed' },
      },
    ]);
    expect(getLiveStreamSeed('sub').streams[0]?.status).toBe('settling');
  });

  it('retains the complete held seed when SQLite finalization did not succeed', () => {
    const streamEpoch = 'failed-finalize-epoch';
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 4,
      parts: [{ type: 'text', text: 'only complete copy' }],
      chunk: { type: 'text-end' },
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      finalParts: [{ type: 'text', text: 'only complete copy' }],
      continuesWakeHold: true,
    });

    finishHeldLiveStreams('sub');

    expect(getLiveStreamSeed('sub').streams[0]).toMatchObject({
      streamEpoch,
      status: 'settling',
      parts: [{ type: 'text', text: 'only complete copy' }],
    });
    expect(listLiveStreamHeaders()).toEqual([
      { subChatId: 'sub', assistantMessageId: 'assistant', streamEpoch },
    ]);
  });

  it('closes prior text at text-start so a seed before the next delta preserves both parts', () => {
    const streamEpoch = 'text-boundary-epoch';
    const previousPart = { type: 'text', text: 'first paragraph' };
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 0,
      parts: [previousPart],
      chunk: { type: 'text-delta', delta: previousPart.text },
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 1,
      parts: [previousPart],
      chunk: { type: 'text-start', id: 'second-paragraph' },
    });

    const seed = getLiveStreamSeed('sub').streams[0];
    expect(seed?.textOpen).toBe(false);
    const restored = assistantPartsStateFromSnapshot(
      (seed?.parts ?? []) as AssistantPartShape[],
      seed?.textOpen ?? false,
    );
    applyAssistantChunkToParts(restored, {
      type: 'text-delta',
      delta: 'second paragraph',
    } as { type: string; delta: string });

    expect(assistantPartsSnapshot(restored)).toEqual([
      previousPart,
      { type: 'text', text: 'second paragraph' },
    ]);
  });

  it('does not reopen closed text for an empty delta in a reconnect seed', () => {
    const streamEpoch = 'empty-delta-boundary-epoch';
    const previousPart = { type: 'text', text: 'first paragraph' };
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 0,
      parts: [previousPart],
      chunk: { type: 'text-end' },
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 1,
      parts: [previousPart],
      chunk: { type: 'text-delta', delta: '' },
    });

    const seed = getLiveStreamSeed('sub').streams[0];
    expect(seed?.textOpen).toBe(false);
    const restored = assistantPartsStateFromSnapshot(
      (seed?.parts ?? []) as AssistantPartShape[],
      seed?.textOpen ?? false,
    );
    applyAssistantChunkToParts(restored, {
      type: 'text-delta',
      delta: 'second paragraph',
    } as { type: string; delta: string });

    expect(assistantPartsSnapshot(restored)).toEqual([
      previousPart,
      { type: 'text', text: 'second paragraph' },
    ]);
  });

  it('retains an exact settling epoch behind a same-id replacement', () => {
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'epoch-old',
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'epoch-old',
      finalParts: [{ type: 'text', text: 'old final answer' }],
      continuesWakeHold: false,
    });
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'epoch-new',
    });

    expect(listLiveStreamHeaders().map(({ streamEpoch }) => streamEpoch)).toEqual([
      'epoch-old',
      'epoch-new',
    ]);
    markLiveStreamCompletionFinalized({
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'epoch-old',
      terminalDurability: { durability: 'committed' },
    });
    expect(
      settleLiveStreamCompletion({
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch: 'epoch-old',
      }),
    ).toBe(true);
    expect(getLiveStreamSeed('sub')).toEqual({
      streams: [expect.objectContaining({ streamEpoch: 'epoch-new', parts: [] })],
      terminals: [
        expect.objectContaining({
          streamEpoch: 'epoch-old',
          durability: 'committed',
        }),
      ],
    });
  });

  it('mints a new epoch when a later turn reuses a settled assistant id', () => {
    const firstEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: firstEpoch,
      messageIndex: 0,
      chunk: { type: 'start' },
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: firstEpoch,
      continuesWakeHold: false,
    });
    settleLiveStreamCompletion({
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: firstEpoch,
    });

    expect(resolveLiveStreamEpoch('sub', 'assistant')).not.toBe(firstEpoch);
  });

  it('does not resurrect an errored or held epoch from a briefly stale execution record', () => {
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const errorEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: errorEpoch,
    });
    recordLiveStreamError({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: errorEpoch,
      error: 'renderer-safe failure',
      category: 'UNKNOWN',
      terminalDurability: { durability: 'non-durable' },
    });

    expect(listLiveStreamHeaders()).toEqual([]);
    expect(getLiveStreamSeed('sub').terminals).toEqual([
      expect.objectContaining({
        status: 'error',
        streamEpoch: errorEpoch,
        error: 'renderer-safe failure',
        category: 'UNKNOWN',
      }),
    ]);

    _clearActiveExecutionsForTests();
    _clearLiveStreamRegistryForTests();
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const heldEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: heldEpoch,
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: heldEpoch,
      continuesWakeHold: true,
    });

    expect(listLiveStreamHeaders()).toEqual([]);
  });

  it('rejects an ordinary late chunk after completion starts', () => {
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'settling-epoch',
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'settling-epoch',
      finalParts: [{ type: 'text', text: 'final answer' }],
      continuesWakeHold: false,
    });

    expect(
      recordLiveStreamChunk({
        chatId: 'chat',
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch: 'settling-epoch',
        messageIndex: 1,
        chunk: { type: 'text-delta', delta: 'late' },
      }),
    ).toBe(false);
    markLiveStreamCompletionFinalized({
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'settling-epoch',
      terminalDurability: { durability: 'committed' },
    });
    expect(
      settleLiveStreamCompletion({
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch: 'settling-epoch',
      }),
    ).toBe(true);
  });

  it('keeps a held epoch closed to ordinary producer chunks', () => {
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'held-epoch',
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'held-epoch',
      continuesWakeHold: true,
    });

    expect(
      recordLiveStreamChunk({
        chatId: 'chat',
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch: 'held-epoch',
        messageIndex: 1,
        chunk: { type: 'text-delta', delta: 'late' },
      }),
    ).toBe(false);
    expect(finishHeldLiveStreams('sub')).toEqual([
      expect.objectContaining({ assistantMessageId: 'assistant', streamEpoch: 'held-epoch' }),
    ]);
  });

  it('retains parts under the retention byte cap', () => {
    const streamEpoch = 'under-cap-epoch';
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 0,
      parts: [{ type: 'text', text: 'small' }],
      chunk: { type: 'text-delta', delta: 'small' },
    });

    expect(getLiveStreamSeed('sub').streams[0]).toMatchObject({
      parts: [{ type: 'text', text: 'small' }],
    });
  });

  it('allows only an explicit wake burst to resume an exact held epoch', () => {
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'wake-epoch',
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch: 'wake-epoch',
      continuesWakeHold: true,
    });

    expect(
      recordLiveStreamChunk({
        chatId: 'chat',
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch: 'wake-epoch',
        messageIndex: 2,
        chunk: { type: 'text-delta', delta: 'continued' },
        wakeBurst: true,
      }),
    ).toBe(true);
    expect(
      beginLiveStreamCompletion({
        chatId: 'chat',
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch: 'wake-epoch',
        continuesWakeHold: false,
      }),
    ).toBe(true);
    expect(
      settleLiveStreamCompletion({
        subChatId: 'sub',
        assistantMessageId: 'assistant',
        streamEpoch: 'wake-epoch',
      }),
    ).toBe(true);
  });

  it('hands a rolled-away turn no parts to repaint, even though its terminal is non-durable', () => {
    // Carrying parts is right for a normal non-durable terminal, but for a truncated turn it is
    // the resurrection path: the reconciler re-appends the message on remount.
    __resetSubChatLocks();
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const streamEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      finalParts: [{ type: 'text', text: 'rolled away' }],
      continuesWakeHold: false,
      observerOwned: true,
    });

    bumpWriteGeneration('sub'); // the rollback lands between the completion and its settle
    settleLiveStreamCompletion({
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      terminalDurability: { durability: 'non-durable' },
    });

    const [terminal] = getLiveStreamSeed('sub').terminals;
    expect(terminal).toMatchObject({ streamEpoch, durability: 'non-durable' });
    expect(terminal?.parts).toBeUndefined();
    __resetSubChatLocks();
  });

  it("stops serving a settled terminal's parts once a LATER rollback replaces the transcript", () => {
    // The check is at read time, not write time: the terminal was legitimately settled with parts,
    // and only the rollback that followed makes them unpaintable.
    __resetSubChatLocks();
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const streamEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    beginLiveStreamCompletion({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      finalParts: [{ type: 'text', text: 'answer' }],
      continuesWakeHold: false,
      observerOwned: true,
    });
    settleLiveStreamCompletion({
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      terminalDurability: { durability: 'non-durable' },
    });
    expect(getLiveStreamSeed('sub').terminals[0]?.parts).toBeDefined();

    bumpWriteGeneration('sub');

    expect(getLiveStreamSeed('sub').terminals[0]?.parts).toBeUndefined();
    __resetSubChatLocks();
  });

  it("stops seeding an ACTIVE stream's parts once a rollback replaces the transcript", () => {
    // The active seed is the other half of the resurrection path: the reconciler paints from it on
    // every remount, so a rolled-away run must hand it nothing.
    __resetSubChatLocks();
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const streamEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 0,
      parts: [{ type: 'text', text: 'rolled away' }],
      chunk: { type: 'text-start' },
    });
    expect(getLiveStreamSeed('sub').streams[0]?.parts).toHaveLength(1);

    bumpWriteGeneration('sub');

    expect(getLiveStreamSeed('sub').streams[0]?.parts).toEqual([]);
    __resetSubChatLocks();
  });

  it('drops the parts on the ERROR terminal too, not only the settled one', () => {
    // recordLiveStreamError is the second terminal writer and copies the settling record's parts.
    __resetSubChatLocks();
    setActiveExecution('sub', new AbortController(), 7, {
      chatId: 'chat',
      assistantMessageId: 'assistant',
    });
    const streamEpoch = resolveLiveStreamEpoch('sub', 'assistant');
    recordLiveStreamStart({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
    });
    recordLiveStreamChunk({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      messageIndex: 0,
      parts: [{ type: 'text', text: 'rolled away' }],
      chunk: { type: 'text-start' },
    });

    bumpWriteGeneration('sub');
    recordLiveStreamError({
      chatId: 'chat',
      subChatId: 'sub',
      assistantMessageId: 'assistant',
      streamEpoch,
      error: 'boom',
      terminalDurability: { durability: 'non-durable' },
    });

    expect(getLiveStreamSeed('sub').terminals[0]?.parts).toBeUndefined();
    __resetSubChatLocks();
  });
});
