/**
 * The wake-hold IPC frames this adapter emits. Shape matters beyond types: the renderer narrows the
 * payload from `unknown`, so what is actually on the wire is the contract — not what the signature
 * permits.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../client';
import {
  _clearLiveStreamRegistryForTests,
  beginLiveStreamCompletion,
  markLiveStreamCompletionFinalized,
} from './live-stream';
import { buildWakeHoldIo } from './wake-hold-io';

function ioWithSpy() {
  const sendWakeHoldChanged = vi.fn();
  const sendExecuteCompleteDirect = vi.fn();
  const sendStreamChunkDirect = vi.fn();
  const sendStreamSettledDirect = vi.fn();
  const io = buildWakeHoldIo({
    chatId: 'c1',
    subChatId: 'sc1',
    buildFinalParts: (): MessagePart[] => [],
    flowDriven: false,
    planAutoApprove: false,
    nextMessageIndex: () => 0,
    send: {
      sendStreamChunkDirect,
      sendExecuteCompleteDirect,
      sendStreamSettledDirect,
      sendWakeHoldChanged,
    },
    clearPendingApprovals: vi.fn(),
    getLatestTaskSignal: () => null,
    clearCurrentExecutionChat: vi.fn(),
  });
  return {
    io,
    sendWakeHoldChanged,
    sendExecuteCompleteDirect,
    sendStreamChunkDirect,
    sendStreamSettledDirect,
  };
}

describe('buildWakeHoldIo — setHeld frames', () => {
  it('marks wake-pump chunks with main-local resume provenance', () => {
    const { io, sendStreamChunkDirect } = ioWithSpy();

    io.streamChunk('assistant', { type: 'text-delta', delta: 'continued' } as never, [], 3);

    expect(sendStreamChunkDirect).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: 'assistant', wakeBurst: true }),
    );
  });

  it('announces a hold with the detail it was given', () => {
    const { io, sendWakeHoldChanged } = ioWithSpy();

    io.setHeld(true, { waitingOn: ['Monitor'] });

    expect(sendWakeHoldChanged).toHaveBeenCalledWith({
      chatId: 'c1',
      subChatId: 'sc1',
      held: true,
      pending: { waitingOn: ['Monitor'] },
    });
  });

  it('separates wake-burst ownership from whether the hold still continues', async () => {
    const { io, sendExecuteCompleteDirect } = ioWithSpy();
    io.setHeld(true, { waitingOn: ['Monitor'] });
    await io.completeBurst('assistant', [{ type: 'finish' } as never], true);
    expect(sendExecuteCompleteDirect).toHaveBeenLastCalledWith(
      expect.objectContaining({ wakeBurst: true, continuesWakeHold: true }),
    );

    io.setHeld(false);
    await io.completeBurst('assistant', [{ type: 'finish' } as never], true);
    expect(sendExecuteCompleteDirect).toHaveBeenLastCalledWith(
      expect.objectContaining({ wakeBurst: true, continuesWakeHold: false }),
    );
  });

  // `pending: undefined` is a PRESENT key, so a retraction carrying it would contradict the wire
  // contract ("absent on a retraction") that the renderer's guard is written against.
  it('omits pending entirely from a retraction, rather than sending it undefined', () => {
    const { io, sendWakeHoldChanged } = ioWithSpy();

    io.setHeld(false);

    const [frame] = sendWakeHoldChanged.mock.calls[0];
    expect(frame).toEqual({ chatId: 'c1', subChatId: 'sc1', held: false });
    expect('pending' in frame).toBe(false);
    expect('endReason' in frame).toBe(false);
  });

  // The renderer holds a held turn's finish chime for this reason alone: a Stop or a follow-up
  // adopting the hold also retracts, and neither is the work finishing.
  it('names a retraction made because the wait ended on its own', () => {
    const { io, sendWakeHoldChanged } = ioWithSpy();

    io.setHeld(false, undefined, 'wait-over');

    expect(sendWakeHoldChanged.mock.calls[0][0]).toStrictEqual({
      chatId: 'c1',
      subChatId: 'sc1',
      held: false,
      endReason: 'wait-over',
    });
  });

  it('emits one epoch settlement when a durably finalized hold retracts', () => {
    _clearLiveStreamRegistryForTests();
    const streamEpoch = 'durable-held-epoch';
    beginLiveStreamCompletion({
      chatId: 'c1',
      subChatId: 'sc1',
      assistantMessageId: 'assistant',
      streamEpoch,
      continuesWakeHold: true,
    });
    markLiveStreamCompletionFinalized({
      subChatId: 'sc1',
      assistantMessageId: 'assistant',
      streamEpoch,
      terminalDurability: { durability: 'committed' },
    });
    const { io, sendStreamSettledDirect } = ioWithSpy();

    io.setHeld(false);
    io.setHeld(false);

    expect(sendStreamSettledDirect).toHaveBeenCalledOnce();
    expect(sendStreamSettledDirect).toHaveBeenCalledWith({
      chatId: 'c1',
      subChatId: 'sc1',
      assistantMessageId: 'assistant',
      streamEpoch,
      terminalDurability: { durability: 'committed' },
    });
  });

  it('emits a non-durable settlement when a failed-finalize hold retracts', () => {
    _clearLiveStreamRegistryForTests();
    const streamEpoch = 'non-durable-held-epoch';
    beginLiveStreamCompletion({
      chatId: 'c1',
      subChatId: 'sc1',
      assistantMessageId: 'assistant',
      streamEpoch,
      finalParts: [{ type: 'text', text: 'recoverable answer' }],
      continuesWakeHold: true,
    });
    markLiveStreamCompletionFinalized({
      subChatId: 'sc1',
      assistantMessageId: 'assistant',
      streamEpoch,
      terminalDurability: { durability: 'non-durable' },
    });
    const { io, sendStreamSettledDirect } = ioWithSpy();

    io.setHeld(false);

    expect(sendStreamSettledDirect).toHaveBeenCalledWith({
      chatId: 'c1',
      subChatId: 'sc1',
      assistantMessageId: 'assistant',
      streamEpoch,
      terminalDurability: { durability: 'non-durable' },
    });
  });
});
