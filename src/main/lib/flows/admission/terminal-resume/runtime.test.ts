import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  startDispatcher: vi.fn(async (_flowRunId: string) => {}),
  resumeDispatcher: vi.fn(async (_intent: unknown) => {}),
  emitRunTerminal: vi.fn(),
}));

vi.mock('../../../db', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../event-emit', () => ({ emitRunTerminal: mocks.emitRunTerminal }));

import { RESTART_INTERRUPTION_REASON } from '../../../../../shared/types/flow';
import { createNodeRun } from '../../../db/repos/node-runs';
import { createSubChat } from '../../../db/repos/sub-chats';
import { createTask, recoverOrphanedTasks, updateTaskStatus } from '../../../db/repos/tasks';
import {
  batchStageRuns,
  batchStages,
  chats,
  flowRuns,
  flows,
  flowVersions,
  nodeRuns,
} from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { _resetFlowAdmissionControllerMutexForTests, FlowAdmissionController } from '../controller';
import {
  _setFlowAdmissionControllerForTests,
  recoverFlowAdmissions,
  registerFlowAdmissionStartDispatcher,
  registerTerminalFlowResumeDispatcher,
  requestFlowAdmissionRelease,
  requestFlowStart,
  requestTerminalFlowResume,
} from '../runtime';
import { stageRestartContinuations } from './boot-continuation';

let db: TestDb;
let controller: FlowAdmissionController;
let maxConcurrentRuns = 1;

const startInput = (key: string) => ({
  flowVersionId: 'version-runtime-resume',
  triggerContext: null,
  idempotencyKey: key,
  batchId: null,
});

function persistTerminalResume(flowRunId: string): string {
  const nodeRunId = `${flowRunId}-resume`;
  db.insert(flowRuns)
    .values({
      id: flowRunId,
      flowVersionId: 'version-runtime-resume',
      status: 'failed',
      startedAt: new Date('2026-08-01T10:00:00Z'),
      completedAt: new Date('2026-08-01T10:05:00Z'),
    })
    .run();
  db.insert(nodeRuns)
    .values({
      id: nodeRunId,
      flowRunId,
      nodeId: 'work',
      blockType: 'agent',
      status: 'failed',
    })
    .run();
  return nodeRunId;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startDispatcher.mockResolvedValue(undefined);
  mocks.resumeDispatcher.mockResolvedValue(undefined);
  maxConcurrentRuns = 1;
  _resetFlowAdmissionControllerMutexForTests();
  db = freshDb();
  db.insert(flows).values({ id: 'flow-runtime-resume', name: 'Resume recovery' }).run();
  db.insert(flowVersions)
    .values({
      id: 'version-runtime-resume',
      flowId: 'flow-runtime-resume',
      versionNumber: 1,
      graph: { nodes: [{ id: 'trigger', blockType: 'manual_trigger' }], edges: [] },
    })
    .run();
  mocks.getDatabase.mockReturnValue(db);
  controller = new FlowAdmissionController(db, async () => ({
    version: 1,
    queuePaused: false,
    concurrencyLimitEnabled: true,
    maxConcurrentRuns,
  }));
  _setFlowAdmissionControllerForTests(controller);
  registerFlowAdmissionStartDispatcher(mocks.startDispatcher);
  registerTerminalFlowResumeDispatcher(mocks.resumeDispatcher);
});

afterEach(() => {
  _setFlowAdmissionControllerForTests(null);
});

describe('terminal Flow resume admission runtime', () => {
  it('recovers a queued resume from its durable node intent exactly once', async () => {
    const nodeRunId = persistTerminalResume('queued-resume');
    const queued = await controller.enqueueTerminalResume({
      flowRunId: 'queued-resume',
      nodeRunId,
    });
    mocks.resumeDispatcher.mockImplementationOnce(async (intent) => {
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'queued-resume')).get()?.status).toBe(
        'running',
      );
      expect(intent).toMatchObject({
        version: 1,
        action: 'resume',
        flow_run_id: 'queued-resume',
        node_run_id: nodeRunId,
      });
    });

    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 0 });
    await vi.waitFor(() => expect(mocks.resumeDispatcher).toHaveBeenCalledOnce());
    expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
      state: 'active',
    });
    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 0, ambiguous: 1 });
    expect(mocks.resumeDispatcher).toHaveBeenCalledOnce();
  });

  it('drops a crash-claimed resume at boot without replaying it; an explicit retry dispatches once', async () => {
    const nodeRunId = persistTerminalResume('claimed-resume');
    const queued = await controller.enqueueTerminalResume({
      flowRunId: 'claimed-resume',
      nodeRunId,
    });
    await controller.claimEligible();

    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 0, ambiguous: 0 });
    // A second boot finds nothing left to recover — the drop is not re-counted.
    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 0, ambiguous: 0 });
    expect(mocks.resumeDispatcher).not.toHaveBeenCalled();
    expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('restart'),
    });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'claimed-resume')).get()?.status).toBe(
      'failed',
    );

    const recovered = await requestTerminalFlowResume({
      flowRunId: 'claimed-resume',
      nodeRunId,
    });
    expect(recovered.created).toBe(true);
    expect(recovered.admission.ticket).not.toBe(queued.admission.ticket);
    await vi.waitFor(() => expect(mocks.resumeDispatcher).toHaveBeenCalledOnce());
    await requestTerminalFlowResume({ flowRunId: 'claimed-resume', nodeRunId });
    expect(mocks.resumeDispatcher).toHaveBeenCalledOnce();
  });

  it.each(['completed', 'cancelled'] as const)(
    'drops a crash-claimed resume whose run is %s without promoting the run',
    async (status) => {
      const flowRunId = `claimed-resume-${status}`;
      const nodeRunId = persistTerminalResume(flowRunId);
      db.update(flowRuns).set({ status }).where(eq(flowRuns.id, flowRunId)).run();
      const queued = await controller.enqueueTerminalResume({ flowRunId, nodeRunId });
      await controller.claimEligible();

      await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 0, ambiguous: 0 });

      expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
        state: 'failed',
      });
      // A user-cancelled run is never resurrected by the drop.
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)).get()?.status).toBe(
        status,
      );
      expect(mocks.resumeDispatcher).not.toHaveBeenCalled();
    },
  );

  it('admits a Retry of a different node once boot drops the crash-claimed resume', async () => {
    const nodeRunId = persistTerminalResume('claimed-other-target');
    db.insert(nodeRuns)
      .values({
        id: 'claimed-other-target-second',
        flowRunId: 'claimed-other-target',
        nodeId: 'work-2',
        blockType: 'agent',
        status: 'failed',
      })
      .run();
    await controller.enqueueTerminalResume({ flowRunId: 'claimed-other-target', nodeRunId });
    await controller.claimEligible();
    // Before boot recovery the stranded claim refuses any other target.
    await expect(
      requestTerminalFlowResume({
        flowRunId: 'claimed-other-target',
        nodeRunId: 'claimed-other-target-second',
      }),
    ).rejects.toThrow(/different live admission/);

    await recoverFlowAdmissions();
    const retried = await requestTerminalFlowResume({
      flowRunId: 'claimed-other-target',
      nodeRunId: 'claimed-other-target-second',
    });

    expect(retried.created).toBe(true);
    await vi.waitFor(() => expect(mocks.resumeDispatcher).toHaveBeenCalledOnce());
    expect(mocks.resumeDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ node_run_id: 'claimed-other-target-second' }),
    );
  });

  it('frees the slot a crash-claimed resume held so a queued start dispatches at boot', async () => {
    const nodeRunId = persistTerminalResume('claimed-slot');
    await controller.enqueueTerminalResume({ flowRunId: 'claimed-slot', nodeRunId });
    await controller.claimEligible();
    const queuedStart = await requestFlowStart(startInput('behind-stranded-resume'));
    expect(mocks.startDispatcher).not.toHaveBeenCalled();

    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 1, ambiguous: 0 });

    await vi.waitFor(() => expect(mocks.startDispatcher).toHaveBeenCalledOnce());
    expect(mocks.startDispatcher).toHaveBeenCalledWith(queuedStart.run.id);
    expect(mocks.resumeDispatcher).not.toHaveBeenCalled();
  });

  it('leaves a claimed resume whose run is no longer terminal ambiguous and untouched', async () => {
    const nodeRunId = persistTerminalResume('claimed-running');
    const queued = await controller.enqueueTerminalResume({
      flowRunId: 'claimed-running',
      nodeRunId,
    });
    await controller.claimEligible();
    db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, 'claimed-running')).run();

    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 0, ambiguous: 1 });

    expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
      state: 'claimed',
      error: null,
    });
    expect(mocks.resumeDispatcher).not.toHaveBeenCalled();
  });

  it('advances the recovery cursor past a page made only of dropped resume claims', async () => {
    maxConcurrentRuns = 2;
    const first = persistTerminalResume('claimed-page-1');
    const second = persistTerminalResume('claimed-page-2');
    const a = await controller.enqueueTerminalResume({
      flowRunId: 'claimed-page-1',
      nodeRunId: first,
    });
    const b = await controller.enqueueTerminalResume({
      flowRunId: 'claimed-page-2',
      nodeRunId: second,
    });
    await controller.claimEligible();

    const page1 = await controller.recoverySnapshot(0, 1);
    expect(page1).toMatchObject({
      autoDrainable: [],
      ambiguous: [],
      nextTicket: a.admission.ticket,
    });
    const page2 = await controller.recoverySnapshot(a.admission.ticket, 1);
    expect(page2).toMatchObject({ autoDrainable: [], ambiguous: [], nextTicket: null });
    expect(await controller.getByTicket(b.admission.ticket)).toMatchObject({ state: 'failed' });
  });

  it('drops a crash-claimed batch-member resume without touching its stage run', async () => {
    const nodeRunId = persistTerminalResume('claimed-member');
    const queued = await controller.enqueueTerminalResume({
      flowRunId: 'claimed-member',
      nodeRunId,
    });
    await controller.claimEligible();
    // The member identity recovery must leave alone: its stage and stage-run rows.
    db.update(flowRuns).set({ batchId: 'batch-m' }).where(eq(flowRuns.id, 'claimed-member')).run();
    db.insert(batchStages)
      .values({ id: 'stage-m', batchId: 'batch-m', stageNumber: 1, status: 'running' })
      .run();
    db.insert(batchStageRuns)
      .values({ id: 'bsr-m', stageId: 'stage-m', flowRunId: 'claimed-member', status: 'failed' })
      .run();

    await expect(recoverFlowAdmissions()).resolves.toEqual({ queued: 0, ambiguous: 0 });

    expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
      state: 'failed',
    });
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, 'bsr-m')).get(),
    ).toMatchObject({ status: 'failed' });
    expect(db.select().from(batchStages).where(eq(batchStages.id, 'stage-m')).get()).toMatchObject({
      status: 'running',
    });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'claimed-member')).get()?.status).toBe(
      'failed',
    );
  });

  it('carries the continuation flag through the durable intent to the dispatcher (user Retry), and omits it otherwise', async () => {
    maxConcurrentRuns = 2;
    const nodeRunId = persistTerminalResume('continuation-resume');
    await requestTerminalFlowResume({
      flowRunId: 'continuation-resume',
      nodeRunId,
      continuation: true,
    });
    await vi.waitFor(() => expect(mocks.resumeDispatcher).toHaveBeenCalledOnce());
    expect(mocks.resumeDispatcher.mock.calls[0][0]).toMatchObject({
      action: 'resume',
      flow_run_id: 'continuation-resume',
      continuation: true,
    });

    // The deliberate re-run surfaces (flows.rerunRun) never set it.
    mocks.resumeDispatcher.mockClear();
    const plainNodeRunId = persistTerminalResume('plain-resume');
    await requestTerminalFlowResume({ flowRunId: 'plain-resume', nodeRunId: plainNodeRunId });
    await vi.waitFor(() => expect(mocks.resumeDispatcher).toHaveBeenCalledOnce());
    expect(
      (mocks.resumeDispatcher.mock.calls[0][0] as { continuation?: true }).continuation,
    ).toBeUndefined();
  });

  it('deduplicates simultaneous retry requests before dispatch', async () => {
    const nodeRunId = persistTerminalResume('concurrent-resume');

    const [first, second] = await Promise.all([
      requestTerminalFlowResume({ flowRunId: 'concurrent-resume', nodeRunId }),
      requestTerminalFlowResume({ flowRunId: 'concurrent-resume', nodeRunId }),
    ]);

    expect(first.admission.ticket).toBe(second.admission.ticket);
    await vi.waitFor(() => expect(mocks.resumeDispatcher).toHaveBeenCalledOnce());
    expect(
      db.select().from(flowRuns).where(eq(flowRuns.id, 'concurrent-resume')).get()?.status,
    ).toBe('running');
  });

  it('settles a failed resume after cleanup, then drains the next start', async () => {
    const nodeRunId = persistTerminalResume('resume-failure');
    let rejectResume!: (error: Error) => void;
    mocks.resumeDispatcher.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectResume = reject;
        }),
    );
    const resumed = await requestTerminalFlowResume({
      flowRunId: 'resume-failure',
      nodeRunId,
    });
    const next = await requestFlowStart(startInput('after-resume-failure'));
    expect(next.run).toMatchObject({ status: 'pending', startedAt: null });

    rejectResume(new Error('resume provider failed'));

    await vi.waitFor(() => expect(mocks.startDispatcher).toHaveBeenCalledOnce());
    expect(await controller.getByTicket(resumed.admission.ticket)).toMatchObject({
      state: 'failed',
    });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'resume-failure')).get()?.status).toBe(
      'failed',
    );
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, next.run.id)).get()?.status).toBe(
      'running',
    );
    expect(mocks.emitRunTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'flow-runtime-resume' }),
      'resume-failure',
      'failed',
      expect.objectContaining({ summary: 'resume provider failed' }),
    );
  });
});

describe('boot carry-on — staged from the startup sweep, fired ahead of queued starts', () => {
  const BOOT_GRAPH = {
    nodes: [
      { id: 'trigger', blockType: 'manual_trigger' },
      { id: 'work', blockType: 'agent', config: { instructions: 'do it' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'work' }],
  };

  /** An admitted run interrupted mid agent turn, exactly as the boot sweep finds it, then swept. */
  async function seedInterruptedAgentRun(
    opts: { sessionId?: string | null; nodeId?: string; laneIndex?: number | null } = {},
  ) {
    db.insert(flowVersions)
      .values({
        id: 'version-boot',
        flowId: 'flow-runtime-resume',
        versionNumber: 2,
        graph: BOOT_GRAPH,
      })
      .run();
    const started = await requestFlowStart({
      ...startInput('boot-interrupted'),
      flowVersionId: 'version-boot',
    });
    await vi.waitFor(() => expect(mocks.startDispatcher).toHaveBeenCalledTimes(1));
    const flowRunId = started.run.id;
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: opts.nodeId ?? 'work',
      blockType: 'agent',
      status: 'running',
      laneIndex: opts.laneIndex ?? null,
      parentFanOutNodeRunId: opts.laneIndex == null ? null : 'fan-out-parent',
    });
    db.insert(chats).values({ id: 'chat-boot' }).run();
    await createSubChat(db, {
      id: 'sc-boot',
      chatId: 'chat-boot',
      name: 'main',
      sessionId: opts.sessionId === undefined ? 'session-abc' : opts.sessionId,
    });
    const result = { chatId: 'chat-boot', subChatId: 'sc-boot', startMode: 'execute' };
    const task = await createTask(db, {
      description: 'agent step',
      source: 'flow',
      sourceId: nodeRun.id,
      flowRunId,
      nodeRunId: nodeRun.id,
      result,
    });
    await updateTaskStatus(db, task.id, 'running', { result });
    db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, flowRunId)).run();
    const swept = await recoverOrphanedTasks(db, new Date(Date.now() + 10_000));
    return { flowRunId, nodeRunId: nodeRun.id, swept };
  }

  /** What the completion watcher leaves once it advances the swept task, ending in the release. */
  async function settleInterruption(flowRunId: string, nodeRunId: string, withMarker: boolean) {
    db.update(nodeRuns)
      .set({
        status: 'cancelled',
        nodeOutput: withMarker ? { error: { message: RESTART_INTERRUPTION_REASON } } : null,
      })
      .where(eq(nodeRuns.id, nodeRunId))
      .run();
    db.update(flowRuns)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(eq(flowRuns.id, flowRunId))
      .run();
    await requestFlowAdmissionRelease(flowRunId);
  }

  it('re-admits the interrupted run as a continuation before a queued start takes its slot', async () => {
    const { flowRunId, nodeRunId, swept } = await seedInterruptedAgentRun();
    expect(await stageRestartContinuations(db, swept)).toBe(1);
    const queued = await requestFlowStart(startInput('queued-behind-boot'));

    await settleInterruption(flowRunId, nodeRunId, true);

    await vi.waitFor(() => expect(mocks.resumeDispatcher).toHaveBeenCalledTimes(1));
    expect(mocks.resumeDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        flow_run_id: flowRunId,
        node_run_id: nodeRunId,
        continuation: true,
      }),
    );
    expect(mocks.startDispatcher).toHaveBeenCalledTimes(1);
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, queued.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
  });

  it('drops the staged entry when the restart marker is gone by fire time (a Cancel landed first)', async () => {
    const { flowRunId, nodeRunId, swept } = await seedInterruptedAgentRun();
    expect(await stageRestartContinuations(db, swept)).toBe(1);
    await requestFlowStart(startInput('queued-behind-cancel'));

    await settleInterruption(flowRunId, nodeRunId, false);

    await vi.waitFor(() => expect(mocks.startDispatcher).toHaveBeenCalledTimes(2));
    expect(mocks.resumeDispatcher).not.toHaveBeenCalled();
    expect(await controller.getLiveForRun(flowRunId)).toBeNull();
  });

  it('a run whose graph cannot be parsed is skipped without costing the others their carry-on', async () => {
    maxConcurrentRuns = 2;
    db.insert(flowVersions)
      .values({
        id: 'version-bad',
        flowId: 'flow-runtime-resume',
        versionNumber: 3,
        graph: 'garbage',
      })
      .run();
    const bad = await requestFlowStart({
      ...startInput('bad-graph'),
      flowVersionId: 'version-bad',
    });
    const badNode = await createNodeRun(db, {
      flowRunId: bad.run.id,
      nodeId: 'work',
      blockType: 'agent',
      status: 'running',
    });
    mocks.startDispatcher.mockClear();
    const { swept } = await seedInterruptedAgentRun();
    const badTask = {
      flowRunId: bad.run.id,
      nodeRunId: badNode.id,
      result: { chatId: 'chat-boot' },
    };
    expect(await stageRestartContinuations(db, [badTask, ...swept])).toBe(1);
  });

  it('drops the staged entry when the chat was deleted before the fire (the abandon path on this base)', async () => {
    const { flowRunId, nodeRunId, swept } = await seedInterruptedAgentRun();
    expect(await stageRestartContinuations(db, swept)).toBe(1);
    await requestFlowStart(startInput('queued-behind-delete'));
    db.delete(chats).where(eq(chats.id, 'chat-boot')).run();

    await settleInterruption(flowRunId, nodeRunId, true);

    await vi.waitFor(() => expect(mocks.startDispatcher).toHaveBeenCalledTimes(2));
    expect(mocks.resumeDispatcher).not.toHaveBeenCalled();
  });

  it.each<[string, Parameters<typeof seedInterruptedAgentRun>[0]]>([
    ['the sub-chat has no session to continue', { sessionId: null }],
    ['the interrupted node is not an agent node', { nodeId: 'trigger' }],
    ['the interrupted node is a fan-out lane', { laneIndex: 0 }],
  ])('stays manual when %s', async (_reason, opts) => {
    const { swept } = await seedInterruptedAgentRun(opts);
    expect(await stageRestartContinuations(db, swept)).toBe(0);
  });

  it('stages a batch member exactly like a non-batch run', async () => {
    const { flowRunId, swept } = await seedInterruptedAgentRun();
    db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId)).run();
    expect(await stageRestartContinuations(db, swept)).toBe(1);
  });

  it('stays manual for a run with no active admission, and a non-flow task', async () => {
    const { flowRunId, swept } = await seedInterruptedAgentRun();
    await requestFlowAdmissionRelease(flowRunId);
    expect(await stageRestartContinuations(db, swept)).toBe(0);

    expect(
      await stageRestartContinuations(db, [{ flowRunId: null, nodeRunId: null, result: null }]),
    ).toBe(0);
  });

  it('stages but never dispatches an interrupted member whose stage already settled', async () => {
    const { flowRunId, nodeRunId, swept } = await seedInterruptedAgentRun();
    db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId)).run();
    db.insert(batchStages)
      .values({ id: 'stage-1', batchId: 'batch-1', stageNumber: 1, status: 'completed' })
      .run();
    // recoverBatchStages (run before admission recovery) already settled this member and the stage
    // around it; staging succeeds and the shared eligibility is what refuses it.
    db.insert(batchStageRuns)
      .values({ id: 'bsr-1', stageId: 'stage-1', flowRunId, status: 'failed' })
      .run();
    expect(await stageRestartContinuations(db, swept)).toBe(1);
    await requestFlowStart(startInput('queued-behind-settled-stage'));

    await settleInterruption(flowRunId, nodeRunId, true);

    // The decline frees the slot for the queued start instead of the continuation.
    await vi.waitFor(() => expect(mocks.startDispatcher).toHaveBeenCalledTimes(2));
    expect(mocks.resumeDispatcher).not.toHaveBeenCalled();
  });
});
