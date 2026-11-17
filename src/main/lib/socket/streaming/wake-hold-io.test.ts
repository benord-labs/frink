/**
 * The wake-hold IPC frames this adapter emits. Shape matters beyond types: the renderer narrows the
 * payload from `unknown`, so what is actually on the wire is the contract — not what the signature
 * permits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../shared/types/plan';
import * as signalPersist from '../../trpc/routers/frink-task-signal-persist';
import type { UIMessageChunk } from '../../claude/types';
import type { MessagePart } from '../client';
import { ChatBusyError, DuplicateMessageError } from '../execution/send-admission';
import * as turnUsage from '../execution/turn-usage';
import * as burstChunks from './burst-chunks';
import {
  _clearLiveStreamRegistryForTests,
  beginLiveStreamCompletion,
  markLiveStreamCompletionFinalized,
} from './live-stream';
import { buildWakeHoldIo } from './wake-hold-io';

const MONITOR_WAIT = {
  waitingOn: [{ id: 'm1', label: 'Monitor', description: 'Watch deploys', stoppable: false }],
};

type PlanAutoApproval = Parameters<typeof buildWakeHoldIo>[0]['planAutoApproval'];

function ioWithSpy(
  build = buildWakeHoldIo,
  planAutoApproval: PlanAutoApproval = null,
  finalParts: MessagePart[] = [],
) {
  const sendWakeHoldChanged = vi.fn();
  const sendExecuteCompleteDirect = vi.fn();
  const sendStreamChunkDirect = vi.fn();
  const sendStreamSettledDirect = vi.fn();
  const sendMessage = vi.fn(async () => undefined);
  const io = build({
    chatId: 'c1',
    subChatId: 'sc1',
    buildFinalParts: (): MessagePart[] => finalParts,
    usageTaskId: 'task-1',
    flowDriven: false,
    planAutoApproval,
    nextMessageIndex: () => 0,
    send: {
      sendStreamChunkDirect,
      sendExecuteCompleteDirect,
      sendStreamSettledDirect,
      sendWakeHoldChanged,
      sendMessage,
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
    sendMessage,
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

    io.setHeld(true, MONITOR_WAIT);

    expect(sendWakeHoldChanged).toHaveBeenCalledWith({
      chatId: 'c1',
      subChatId: 'sc1',
      held: true,
      pending: MONITOR_WAIT,
    });
  });

  it('separates wake-burst ownership from whether the hold still continues', async () => {
    const { io, sendExecuteCompleteDirect } = ioWithSpy();
    io.setHeld(true, MONITOR_WAIT);
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

  // The renderer chimes only on 'wait-over', and warns that Stop also ends the background work
  // only on 'adopted'; a bare retraction (Stop, release) must stay distinguishable from both.
  it.each(['wait-over', 'adopted'] as const)('names a %s retraction', (endReason) => {
    const { io, sendWakeHoldChanged } = ioWithSpy();

    io.setHeld(false, undefined, endReason);

    expect(sendWakeHoldChanged.mock.calls[0][0]).toStrictEqual({
      chatId: 'c1',
      subChatId: 'sc1',
      held: false,
      endReason,
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

describe('buildWakeHoldIo — live work', () => {
  it('reports a held wait as live work until every hold retracts, stale ones included', async () => {
    // Fresh modules: earlier tests here leave holds set in the module-level registry.
    vi.resetModules();
    const { isWorkActive } = await import('../../power/work-activity');
    const { buildWakeHoldIo: build } = await import('./wake-hold-io');
    const stale = ioWithSpy(build).io;
    const successor = ioWithSpy(build).io;
    stale.setHeld(true, MONITOR_WAIT);
    successor.setHeld(true, MONITOR_WAIT);
    expect(isWorkActive()).toBe(true);

    stale.setHeld(false);
    expect(isWorkActive()).toBe(true);
    successor.setHeld(false);
    expect(isWorkActive()).toBe(false);
  });
});

describe('buildWakeHoldIo — burst context usage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A node whose wait ends in a burst signals from that burst, so the burst — not the arming
  // turn — holds the node's final occupancy; it must be on the row before the signal flips it.
  it("re-stamps the burst's message with its last finish usage before completeBurst returns", async () => {
    let stamped = false;
    const stamp = vi.spyOn(turnUsage, 'stampTurnUsage').mockImplementation(async () => {
      stamped = true;
    });
    const parts: MessagePart[] = [{ type: 'text', text: 'build passed' }];
    const { io } = ioWithSpy(buildWakeHoldIo, null, parts);
    const chunks: UIMessageChunk[] = [
      { type: 'finish', messageMetadata: { contextTokens: 10 } },
      { type: 'finish', messageMetadata: { contextTokens: 70_000 } },
    ];

    await io.completeBurst('assistant', chunks, true);

    expect(stamped).toBe(true);
    expect(stamp).toHaveBeenCalledWith(
      'task-1',
      'assistant',
      { contextTokens: 70_000 },
      parts,
      true,
    );
  });

  it('stamps nothing for an all-dropped burst', async () => {
    const stamp = vi.spyOn(turnUsage, 'stampTurnUsage').mockResolvedValue();
    const { io } = ioWithSpy();
    await io.completeBurst('assistant', [{ type: 'finish' }], false);
    expect(stamp).not.toHaveBeenCalled();
  });
});

describe('buildWakeHoldIo — auto-approved plan', () => {
  const APPROVAL = { projectId: 'p1', settings: { autoReviewTools: true }, signalTaskId: 'task-1' };
  const burstTurn = { onSubmitted: vi.fn(), planAlreadySubmitted: false, waitStartedMs: 0 };
  const carded = (planText: string | null) =>
    vi.spyOn(burstChunks, 'emitBurstPlanCard').mockResolvedValue(planText);
  const parked = () => vi.spyOn(signalPersist, 'persistLinkedTaskSignal').mockResolvedValue(true);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const endBurst = async (io: ReturnType<typeof buildWakeHoldIo>) => {
    await io.emitPlanCard('assistant', [], 0, new Map(), burstTurn);
    // SAFETY: completeBurst only forwards the chunks to the stubbed buildFinalParts.
    await io.completeBurst('assistant', [{ type: 'finish' } as never], true);
    await flush();
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('approves the carded plan in a new Agent-mode turn, after the burst is persisted', async () => {
    carded('# Plan');
    const { io, sendMessage, sendExecuteCompleteDirect } = ioWithSpy(buildWakeHoldIo, APPROVAL);

    await endBurst(io);

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      {
        chatId: 'c1',
        subChatId: 'sc1',
        projectId: 'p1',
        userMessage: {
          id: 'plan-approval-assistant',
          role: 'user',
          parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
        },
        mode: 'agent',
        settings: APPROVAL.settings,
        approvedPlanContext: { planText: '# Plan' },
        expectedFlowTaskId: 'task-1',
      },
      { rejectIfBusy: true },
    );
    expect(sendExecuteCompleteDirect.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0],
    );
  });

  it('approves a carded plan once, however many bursts end after it', async () => {
    const card = carded('# Plan');
    const { io, sendMessage } = ioWithSpy(buildWakeHoldIo, APPROVAL);

    await endBurst(io);
    card.mockResolvedValue(null);
    await endBurst(io);

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('never approves on a node that is not auto-approved', async () => {
    const card = carded(null);
    const { io, sendMessage } = ioWithSpy();

    await endBurst(io);

    expect(card).toHaveBeenCalledWith(expect.objectContaining({ planAutoApprove: false }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('parks the task at once, naming the cause, when the run settings are missing', async () => {
    carded('# Plan');
    const park = parked();
    const { io, sendMessage } = ioWithSpy(buildWakeHoldIo, { ...APPROVAL, settings: undefined });

    await endBurst(io);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(park).toHaveBeenCalledWith({
      taskIdForExecution: 'task-1',
      signal: expect.objectContaining({
        state: 'blocked',
        summary: expect.stringContaining('settings could not be read'),
      }),
    });
  });

  it('parks the task at once when the approval turn cannot start', async () => {
    carded('# Plan');
    const park = parked();
    const { io, sendMessage } = ioWithSpy(buildWakeHoldIo, APPROVAL);
    sendMessage.mockRejectedValueOnce(new Error('account signed out'));

    await endBurst(io);

    expect(park).toHaveBeenCalledWith({
      taskIdForExecution: 'task-1',
      signal: expect.objectContaining({ summary: expect.stringContaining('account signed out') }),
    });
  });

  it.each([
    ['a user turn owns the chat', new ChatBusyError()],
    ['the approval was already saved', new DuplicateMessageError()],
    ['the Flow run ended', Object.assign(new Error('ended'), { category: 'FLOW_RUN_ENDED' })],
    [
      'the paused Flow run resumes itself',
      Object.assign(new Error('paused'), { category: 'FLOW_RUN_RESUMING' }),
    ],
  ])('parks nothing when %s', async (_reason, refusal) => {
    carded('# Plan');
    const park = parked();
    const { io, sendMessage } = ioWithSpy(buildWakeHoldIo, APPROVAL);
    sendMessage.mockRejectedValueOnce(refusal);

    await endBurst(io);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(park).not.toHaveBeenCalled();
  });
});
