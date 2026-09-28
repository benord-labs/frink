import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chats,
  flowRunAdmissions,
  flowRuns,
  flows,
  flowVersions,
  nodeRuns,
  subChats,
  tasks,
} from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import {
  _resetFlowAdmissionControllerMutexForTests,
  type FlowAdmissionConfig,
  FlowAdmissionController,
} from '.';
import {
  admissionVisibilityForRuns,
  flowRunAdmissionSnapshotsForRuns,
  queuedRunsForFlows,
} from './visibility';

const GRAPH = { nodes: [], edges: [], settings: {} };

function seedRuns(db: TestDb, ids: string[], status = 'pending'): void {
  db.insert(flows)
    .values({ id: `flow-${ids.join('-')}`, name: 'Flow' })
    .run();
  db.insert(flowVersions)
    .values({
      id: `version-${ids.join('-')}`,
      flowId: `flow-${ids.join('-')}`,
      versionNumber: 1,
      graph: GRAPH,
    })
    .run();
  for (const id of ids) {
    db.insert(flowRuns)
      .values({
        id,
        flowVersionId: `version-${ids.join('-')}`,
        status,
        startedAt: status === 'pending' ? null : new Date('2026-08-01T10:00:00Z'),
      })
      .run();
  }
}

function controllerWithMutableConfig(
  db: TestDb,
  initial: Partial<FlowAdmissionConfig> = {},
): {
  controller: FlowAdmissionController;
  setConfig: (patch: Partial<FlowAdmissionConfig>) => void;
} {
  let current: FlowAdmissionConfig = {
    version: 1,
    queuePaused: false,
    concurrencyLimitEnabled: true,
    maxConcurrentRuns: 4,
    ...initial,
  };
  return {
    controller: new FlowAdmissionController(db, async () => ({ ...current })),
    setConfig: (patch) => {
      current = { ...current, ...patch };
    },
  };
}

async function enqueueStart(controller: FlowAdmissionController, flowRunId: string) {
  return controller.enqueue({
    intent: { version: 1, action: 'start', flow_run_id: flowRunId },
  });
}

async function claimRows(controller: FlowAdmissionController) {
  return (await controller.claimEligible()).admissions;
}

function seedResumeNode(db: TestDb, flowRunId: string): string {
  const id = `node-${flowRunId}`;
  db.insert(nodeRuns)
    .values({ id, flowRunId, nodeId: 'agent', blockType: 'agent', status: 'awaiting_input' })
    .run();
  return id;
}

describe('FlowAdmissionController', () => {
  beforeEach(() => {
    _resetFlowAdmissionControllerMutexForTests();
  });

  it.each([true, false])(
    'holds starts and resumes while paused (limit enabled: %s)',
    async (concurrencyLimitEnabled) => {
      const db = freshDb();
      seedRuns(db, ['start-1', 'start-2']);
      seedRuns(db, ['resume'], 'failed');
      const nodeRunId = seedResumeNode(db, 'resume');
      const { controller, setConfig } = controllerWithMutableConfig(db, {
        queuePaused: true,
        concurrencyLimitEnabled,
      });
      const first = await enqueueStart(controller, 'start-1');
      const second = await enqueueStart(controller, 'start-2');
      await controller.moveQueued(second.admission.ticket, first.admission.ticket);
      const resume = await controller.enqueue({
        intent: { version: 1, action: 'resume', flow_run_id: 'resume', node_run_id: nodeRunId },
      });
      await expect(controller.claimEligible()).resolves.toMatchObject({
        admissions: [],
        failed: [],
        hasMore: true,
        candidatesProcessed: 0,
      });
      expect((await controller.getSnapshot()).counts.queued).toBe(3);
      setConfig({ queuePaused: false });
      await controller.refreshConfig();
      expect((await claimRows(controller)).map((row) => row.ticket)).toEqual([
        resume.admission.ticket,
        second.admission.ticket,
        first.admission.ticket,
      ]);
    },
  );

  it('returns claimed work to its queue position when pause wins the dispatch race', async () => {
    const db = freshDb();
    seedRuns(db, ['active', 'first', 'second']);
    const { controller, setConfig } = controllerWithMutableConfig(db);
    const active = await enqueueStart(controller, 'active');
    await controller.claimEligible();
    await controller.beginDispatch(active.admission.ticket);
    const first = await enqueueStart(controller, 'first');
    const second = await enqueueStart(controller, 'second');
    await controller.moveQueued(second.admission.ticket, first.admission.ticket);
    const claimed = await claimRows(controller);
    setConfig({ queuePaused: true });
    await controller.refreshConfig();
    for (const row of claimed) {
      await expect(controller.beginDispatch(row.ticket)).resolves.toBeNull();
      expect(await controller.getByTicket(row.ticket)).toMatchObject({
        state: 'queued',
        claimedAt: null,
        startedAt: null,
        queueOrder: row.queueOrder,
      });
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, row.flowRunId)).get()).toMatchObject({
        status: 'pending',
        startedAt: null,
      });
    }
    expect(await controller.getByTicket(active.admission.ticket)).toMatchObject({
      state: 'active',
    });
    setConfig({ queuePaused: false });
    await controller.refreshConfig();
    expect((await claimRows(controller)).map((row) => row.ticket)).toEqual([
      second.admission.ticket,
      first.admission.ticket,
    ]);
  });

  it('retains the effective pause when saving resume fails', async () => {
    const db = freshDb();
    seedRuns(db, ['pending']);
    const controller = new FlowAdmissionController(
      db,
      async () => ({
        version: 1,
        queuePaused: true,
        concurrencyLimitEnabled: true,
        maxConcurrentRuns: 4,
      }),
      async () => {
        throw new Error('Config write failed');
      },
    );
    await enqueueStart(controller, 'pending');
    await controller.getSnapshot();
    await expect(controller.updateConfig({ queuePaused: false })).rejects.toThrow(
      'Config write failed',
    );
    expect((await controller.getSnapshot()).config.queuePaused).toBe(true);
    expect(await claimRows(controller)).toEqual([]);
  });

  it('claims at most four simultaneous starts in monotonic ticket order', async () => {
    const db = freshDb();
    const ids = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'];
    seedRuns(db, ids);
    const { controller } = controllerWithMutableConfig(db);
    const enqueued = await Promise.all(ids.map((id) => enqueueStart(controller, id)));
    const tickets = enqueued.map((item) => item.admission.ticket).sort((a, b) => a - b);

    const { admissions: claimed } = await controller.claimEligible(
      new Date('2026-08-01T12:00:00Z'),
    );

    expect(claimed.map((row) => row.ticket)).toEqual(tickets.slice(0, 4));
    expect(await claimRows(controller)).toEqual([]);
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'run-1')).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    await controller.beginDispatch(claimed[0].ticket);
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'run-1')).get()?.status).toBe(
      'running',
    );
    const fifth = db.select().from(flowRuns).where(eq(flowRuns.id, 'run-5')).get();
    expect(fifth).toMatchObject({ status: 'pending', startedAt: null });
  });

  it('prioritizes the oldest resume ahead of untouched starts without preemption', async () => {
    const db = freshDb();
    seedRuns(db, ['start-1', 'start-2']);
    seedRuns(db, ['resume-1'], 'failed');
    const nodeRunId = seedResumeNode(db, 'resume-1');
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 1 });
    await enqueueStart(controller, 'start-1');
    await enqueueStart(controller, 'start-2');
    const resume = await controller.enqueue({
      intent: { version: 1, action: 'resume', flow_run_id: 'resume-1', node_run_id: nodeRunId },
    });

    const [claimed] = await claimRows(controller);

    expect(claimed.ticket).toBe(resume.admission.ticket);
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'resume-1')).get()?.status).toBe(
      'failed',
    );
  });

  it('preserves FIFO order within the resume-priority class', async () => {
    const db = freshDb();
    seedRuns(db, ['start']);
    seedRuns(db, ['resume-1', 'resume-2'], 'failed');
    const firstNodeRunId = seedResumeNode(db, 'resume-1');
    const secondNodeRunId = seedResumeNode(db, 'resume-2');
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 2 });
    await enqueueStart(controller, 'start');
    const firstResume = await controller.enqueue({
      intent: {
        version: 1,
        action: 'resume',
        flow_run_id: 'resume-1',
        node_run_id: firstNodeRunId,
      },
    });
    const secondResume = await controller.enqueue({
      intent: {
        version: 1,
        action: 'resume',
        flow_run_id: 'resume-2',
        node_run_id: secondNodeRunId,
      },
    });

    const claimed = await claimRows(controller);

    expect(claimed.map((row) => row.ticket)).toEqual([
      firstResume.admission.ticket,
      secondResume.admission.ticket,
    ]);
  });

  describe('cancelUndispatchedForRun guard', () => {
    it('declines a stale ticket and leaves the queue intact', async () => {
      const db = freshDb();
      seedRuns(db, ['run-1']);
      const { controller } = controllerWithMutableConfig(db);
      const { admission } = await enqueueStart(controller, 'run-1');

      const declined = await controller.cancelUndispatchedForRun('run-1', new Date(), {
        states: ['queued'],
        ticket: admission.ticket + 1000,
      });

      expect(declined).toBeNull();
      expect(await controller.getByTicket(admission.ticket)).toMatchObject({ state: 'queued' });
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'run-1')).get()?.status).toBe(
        'pending',
      );
    });

    it('declines work the scheduler already claimed, so a dequeue never preempts it', async () => {
      const db = freshDb();
      seedRuns(db, ['run-1']);
      const { controller } = controllerWithMutableConfig(db);
      const { admission } = await enqueueStart(controller, 'run-1');
      await claimRows(controller);

      const declined = await controller.cancelUndispatchedForRun('run-1', new Date(), {
        states: ['queued'],
      });

      expect(declined).toBeNull();
      expect(await controller.getByTicket(admission.ticket)).toMatchObject({ state: 'claimed' });

      // Without the narrowed states the same claimed row is still cancellable, as before.
      expect(await controller.cancelUndispatchedForRun('run-1')).toMatchObject({
        state: 'cancelled',
      });
    });

    it('declines a replacement ticket that took the run over after the caller read it', async () => {
      const db = freshDb();
      seedRuns(db, ['run-1']);
      const { controller } = controllerWithMutableConfig(db);
      const { admission } = await enqueueStart(controller, 'run-1');

      const declined = await controller.cancelUndispatchedForRun('run-1', new Date(), {
        states: ['queued'],
        ticket: admission.ticket + 1,
      });

      expect(declined).toBeNull();
      expect(await controller.getByTicket(admission.ticket)).toMatchObject({ state: 'queued' });
    });

    it('dequeues an owned queued start, terminalizing the run it never dispatched', async () => {
      const db = freshDb();
      seedRuns(db, ['run-1']);
      const { controller } = controllerWithMutableConfig(db);
      const { admission } = await enqueueStart(controller, 'run-1');

      const cancelled = await controller.cancelUndispatchedForRun('run-1', new Date(), {
        states: ['queued'],
        ticket: admission.ticket,
      });

      expect(cancelled).toMatchObject({ state: 'cancelled' });
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'run-1')).get()?.status).toBe(
        'cancelled',
      );
    });

    it('dequeues an owned queued resume without disturbing its already-terminal run', async () => {
      const db = freshDb();
      seedRuns(db, ['resume-1'], 'failed');
      const nodeRunId = seedResumeNode(db, 'resume-1');
      const { controller } = controllerWithMutableConfig(db);
      await controller.enqueue({
        intent: {
          version: 1,
          action: 'resume',
          flow_run_id: 'resume-1',
          node_run_id: nodeRunId,
        },
      });

      const cancelled = await controller.cancelUndispatchedForRun('resume-1', new Date(), {
        states: ['queued'],
      });

      expect(cancelled).toMatchObject({ state: 'cancelled' });
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'resume-1')).get()?.status).toBe(
        'failed',
      );
    });
  });

  it('reports priority/FIFO queue positions and shifts them after cancellation', async () => {
    const db = freshDb();
    seedRuns(db, ['start-1', 'start-2']);
    seedRuns(db, ['resume'], 'failed');
    const nodeRunId = seedResumeNode(db, 'resume');
    const { controller } = controllerWithMutableConfig(db);
    await controller.enqueue({
      intent: { version: 1, action: 'start', flow_run_id: 'start-1' },
      requestedAt: new Date('2026-08-01T10:00:00Z'),
    });
    await controller.enqueue({
      intent: { version: 1, action: 'start', flow_run_id: 'start-2' },
      requestedAt: new Date('2026-08-01T10:01:00Z'),
    });
    const resume = await controller.enqueue({
      intent: { version: 1, action: 'resume', flow_run_id: 'resume', node_run_id: nodeRunId },
      requestedAt: new Date('2026-08-01T10:02:00Z'),
    });

    const initial = admissionVisibilityForRuns(db, ['start-1', 'start-2', 'resume']);
    expect(flowRunAdmissionSnapshotsForRuns(db, ['resume']).get('resume')).toMatchObject({
      runStatus: 'failed',
      admission: { admissionState: 'queued', queuePosition: 1 },
    });
    expect(initial.get('resume')).toMatchObject({ admissionState: 'queued', queuePosition: 1 });
    expect(initial.get('start-1')).toMatchObject({
      admissionState: 'queued',
      queuePosition: 2,
      requestedAt: new Date('2026-08-01T10:00:00Z'),
    });
    expect(initial.get('start-2')?.queuePosition).toBe(3);
    expect(queuedRunsForFlows(db, ['flow-resume']).get('flow-resume')).toMatchObject({
      id: 'resume',
      status: 'failed',
    });

    await controller.requestCancellation(resume.admission.ticket);
    const shifted = admissionVisibilityForRuns(db, ['start-1', 'resume']);
    expect(shifted.get('start-1')?.queuePosition).toBe(1);
    expect(shifted.has('resume')).toBe(false);
    expect(flowRunAdmissionSnapshotsForRuns(db, ['resume']).get('resume')).toMatchObject({
      runStatus: 'failed',
      admission: null,
    });
  });

  it('tracks Unlimited work while bounding each claim transaction', async () => {
    const db = freshDb();
    const ids = Array.from({ length: 45 }, (_, index) => `unlimited-${index}`);
    seedRuns(db, ids);
    const { controller } = controllerWithMutableConfig(db, { concurrencyLimitEnabled: false });
    await Promise.all(ids.map((id) => enqueueStart(controller, id)));

    expect(await claimRows(controller)).toHaveLength(20);
    expect(await claimRows(controller)).toHaveLength(20);
    expect(await claimRows(controller)).toHaveLength(5);
    expect((await controller.getSnapshot()).occupied).toBe(45);
  });

  it('does not let an older config read overwrite a completed refresh', async () => {
    const db = freshDb();
    let resolveFirst: (config: FlowAdmissionConfig) => void = () => undefined;
    const firstRead = new Promise<FlowAdmissionConfig>((resolve) => {
      resolveFirst = resolve;
    });
    let reads = 0;
    const lower = {
      version: 1,
      queuePaused: false,
      concurrencyLimitEnabled: true,
      maxConcurrentRuns: 2,
    } as const;
    const controller = new FlowAdmissionController(db, () => {
      reads += 1;
      return reads === 1 ? firstRead : Promise.resolve(lower);
    });

    const staleSnapshot = controller.getSnapshot();
    await vi.waitFor(() => expect(reads).toBe(1));
    const refresh = controller.refreshConfig();
    resolveFirst({ ...lower, maxConcurrentRuns: 4 });
    await Promise.all([staleSnapshot, refresh]);

    expect((await controller.getSnapshot()).config.maxConcurrentRuns).toBe(2);
  });

  it('drains over a lowered cap without preempting and reacts to raises or Unlimited', async () => {
    const db = freshDb();
    seedRuns(db, ['drain-1', 'drain-2', 'drain-3', 'drain-4', 'drain-5', 'drain-6']);
    const state = controllerWithMutableConfig(db);
    await Promise.all(
      ['drain-1', 'drain-2', 'drain-3', 'drain-4', 'drain-5', 'drain-6'].map((id) =>
        enqueueStart(state.controller, id),
      ),
    );
    const first = await claimRows(state.controller);
    await Promise.all(first.map((row) => state.controller.beginDispatch(row.ticket)));

    state.setConfig({ maxConcurrentRuns: 2 });
    await state.controller.refreshConfig();
    expect(await state.controller.getSnapshot()).toMatchObject({ occupied: 4, draining: true });
    expect(await claimRows(state.controller)).toEqual([]);

    state.setConfig({ maxConcurrentRuns: 5 });
    await state.controller.refreshConfig();
    expect(await claimRows(state.controller)).toHaveLength(1);

    state.setConfig({ concurrencyLimitEnabled: false });
    await state.controller.refreshConfig();
    expect(await claimRows(state.controller)).toHaveLength(1);
  });

  it('returns the existing activation when a run already has a live admission', async () => {
    const db = freshDb();
    seedRuns(db, ['dedupe']);
    const { controller } = controllerWithMutableConfig(db);

    const [first, second] = await Promise.all([
      enqueueStart(controller, 'dedupe'),
      enqueueStart(controller, 'dedupe'),
    ]);

    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.admission.ticket).toBe(second.admission.ticket);
    expect(db.select().from(flowRunAdmissions).all()).toHaveLength(1);
  });

  it('serializes cancellation against claiming without dispatching a cancelled ticket', async () => {
    const db = freshDb();
    seedRuns(db, ['cancel-race']);
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 1 });
    const queued = await enqueueStart(controller, 'cancel-race');

    await Promise.all([
      controller.claimEligible(new Date('2026-08-01T12:00:00Z')),
      controller.requestCancellation(queued.admission.ticket, new Date('2026-08-01T12:00:01Z')),
    ]);

    const row = db
      .select()
      .from(flowRunAdmissions)
      .where(eq(flowRunAdmissions.ticket, queued.admission.ticket))
      .get();
    expect(['cancelled', 'releasing']).toContain(row?.state);
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'cancel-race')).get()?.status).toBe(
      'cancelled',
    );
    expect(await controller.beginDispatch(queued.admission.ticket)).toBeNull();
  });

  it('crosses the automatic-dispatch boundary at most once', async () => {
    const db = freshDb();
    seedRuns(db, ['dispatch-once']);
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 1 });
    await enqueueStart(controller, 'dispatch-once');
    const [claimed] = await claimRows(controller);

    const attempts = await Promise.all([
      controller.beginDispatch(claimed.ticket),
      controller.beginDispatch(claimed.ticket),
    ]);

    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(attempts.find(Boolean)).toMatchObject({ state: 'active' });
  });

  it('keeps releasing work occupied until cleanup settles successfully', async () => {
    const db = freshDb();
    seedRuns(db, ['lease-1', 'lease-2']);
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 1 });
    await enqueueStart(controller, 'lease-1');
    await enqueueStart(controller, 'lease-2');
    const [first] = await claimRows(controller);
    await controller.beginDispatch(first.ticket);
    db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, 'lease-1')).run();
    await controller.requestCancellation(first.ticket);
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, 'lease-1')).get()?.status).toBe(
      'cancelled',
    );

    expect(await claimRows(controller)).toEqual([]);
    const failedCleanup = await controller.recordReleaseFailure(
      first.ticket,
      'provider still alive',
    );
    expect(failedCleanup).toMatchObject({ state: 'releasing', error: 'provider still alive' });
    expect(await claimRows(controller)).toEqual([]);

    await controller.settle(first.ticket, 'released');
    expect(await claimRows(controller)).toHaveLength(1);
  });

  it('requeues only proven-unstarted claims for automatic recovery', async () => {
    const db = freshDb();
    seedRuns(db, ['recovery-1', 'recovery-2', 'recovery-3', 'recovery-4', 'recovery-5']);
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 4 });
    await Promise.all(
      ['recovery-1', 'recovery-2', 'recovery-3', 'recovery-4', 'recovery-5'].map((id) =>
        enqueueStart(controller, id),
      ),
    );
    const claimed = await claimRows(controller);
    await controller.beginDispatch(claimed[0].ticket);
    await controller.beginRelease(claimed[0].ticket);
    await controller.beginDispatch(claimed[1].ticket);
    db.update(flowRunAdmissions)
      .set({ queueOrder: 1 })
      .where(eq(flowRunAdmissions.ticket, claimed[2].ticket))
      .run();
    db.update(flowRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(flowRuns.id, claimed[3].flowRunId))
      .run();

    const recovery = await controller.recoverySnapshot();

    expect(recovery.autoDrainable.map((row) => row.state)).toEqual(['queued', 'queued']);
    expect(
      recovery.autoDrainable.find((row) => row.ticket === claimed[2].ticket)?.queueOrder,
    ).toBeNull();
    expect(recovery.ambiguous.map((row) => row.state).sort()).toEqual([
      'active',
      'claimed',
      'releasing',
    ]);
  });

  it('fails unknown intents and missing canonical references without retry-looping', async () => {
    const db = freshDb();
    const missingIds = Array.from({ length: 100 }, (_, index) => `missing-reference-${index}`);
    seedRuns(db, ['invalid-version', ...missingIds, 'corrupt-messages', 'valid']);
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 1 });
    const invalid = await enqueueStart(controller, 'invalid-version');
    db.update(flowRunAdmissions)
      .set({ intentVersion: 99 })
      .where(eq(flowRunAdmissions.ticket, invalid.admission.ticket))
      .run();
    const missing = await Promise.all(
      missingIds.map((flowRunId) =>
        controller.enqueue({
          intent: { version: 1, action: 'resume', flow_run_id: flowRunId, task_id: 'missing' },
        }),
      ),
    );
    db.insert(chats).values({ id: 'flow-chat' }).run();
    db.insert(subChats)
      .values({ id: 'flow-sub-chat', chatId: 'flow-chat', messages: '{corrupt' })
      .run();
    db.insert(tasks)
      .values({
        id: 'flow-task',
        description: 'Flow task',
        source: 'flow',
        flowRunId: 'corrupt-messages',
        result: { subChatId: 'flow-sub-chat' },
      })
      .run();
    const corrupt = await controller.enqueue({
      intent: {
        version: 1,
        action: 'resume',
        flow_run_id: 'corrupt-messages',
        task_id: 'flow-task',
        sub_chat_id: 'flow-sub-chat',
        message_id: 'answer',
      },
    });
    await enqueueStart(controller, 'valid');

    expect(await controller.claimEligible()).toMatchObject({
      admissions: [],
      hasMore: true,
      candidatesProcessed: 100,
    });
    const claimed = await claimRows(controller);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].flowRunId).toBe('valid');
    expect(
      db
        .select()
        .from(flowRunAdmissions)
        .where(eq(flowRunAdmissions.ticket, invalid.admission.ticket))
        .get(),
    ).toMatchObject({ state: 'failed', error: expect.stringContaining('Unsupported') });
    expect(
      db
        .select()
        .from(flowRunAdmissions)
        .where(eq(flowRunAdmissions.ticket, missing[0].admission.ticket))
        .get(),
    ).toMatchObject({ state: 'failed', error: expect.stringContaining('Missing task') });
    expect(
      db
        .select()
        .from(flowRunAdmissions)
        .where(eq(flowRunAdmissions.ticket, corrupt.admission.ticket))
        .get(),
    ).toMatchObject({ state: 'failed', error: expect.stringContaining('Invalid messages') });
  });

  it('cascades hard-deleted runs and prunes only old settled history', async () => {
    const db = freshDb();
    seedRuns(db, ['delete-me', 'old-terminal', 'new-terminal']);
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 2 });
    await enqueueStart(controller, 'delete-me');
    db.delete(flowRuns).where(eq(flowRuns.id, 'delete-me')).run();
    expect(db.select().from(flowRunAdmissions).all()).toEqual([]);

    await enqueueStart(controller, 'old-terminal');
    await enqueueStart(controller, 'new-terminal');
    const { admissions: claimed } = await controller.claimEligible(
      new Date('2026-06-01T00:00:00Z'),
    );
    for (const row of claimed) {
      await controller.beginDispatch(row.ticket, new Date('2026-06-01T00:00:01Z'));
      await controller.beginRelease(row.ticket);
    }
    await controller.settle(claimed[0].ticket, 'released', null, new Date('2026-06-01T00:00:02Z'));
    await controller.settle(claimed[1].ticket, 'released', null, new Date('2026-08-01T00:00:02Z'));

    expect(await controller.pruneExpiredHistory(new Date('2026-07-01T00:00:00Z'))).toBe(1);
    expect(db.select().from(flowRunAdmissions).all()).toHaveLength(1);
  });

  it('blocks deleting a run while its admission may still hold resources', async () => {
    const db = freshDb();
    seedRuns(db, ['occupied-delete']);
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 1 });
    await enqueueStart(controller, 'occupied-delete');
    const [claimed] = await claimRows(controller);
    await controller.beginDispatch(claimed.ticket);

    expect(() => db.delete(flowRuns).where(eq(flowRuns.id, 'occupied-delete')).run()).toThrow(
      /holds resources/,
    );
    expect(db.select().from(flowRunAdmissions).all()).toHaveLength(1);
  });

  it('allows a later activation only after the prior admission settles', async () => {
    const db = freshDb();
    seedRuns(db, ['reactivate']);
    const nodeRunId = seedResumeNode(db, 'reactivate');
    const { controller } = controllerWithMutableConfig(db, { maxConcurrentRuns: 1 });
    const first = await enqueueStart(controller, 'reactivate');
    const duplicate = await controller.enqueue({
      intent: { version: 1, action: 'resume', flow_run_id: 'reactivate', node_run_id: nodeRunId },
    });
    expect(duplicate).toMatchObject({ created: false });
    expect(duplicate.admission.ticket).toBe(first.admission.ticket);

    const [claimed] = await claimRows(controller);
    await controller.beginDispatch(claimed.ticket);
    await controller.beginRelease(claimed.ticket);
    await controller.settle(claimed.ticket, 'released');
    const later = await controller.enqueue({
      intent: { version: 1, action: 'resume', flow_run_id: 'reactivate', node_run_id: nodeRunId },
    });

    expect(later.created).toBe(true);
    expect(later.admission.ticket).toBeGreaterThan(first.admission.ticket);
    expect(db.select().from(flowRunAdmissions).all()).toHaveLength(2);
    expect(admissionVisibilityForRuns(db, ['reactivate']).get('reactivate')).toMatchObject({
      admissionState: 'queued',
      queuePosition: 1,
      requestedAt: later.admission.requestedAt,
    });
  });

  it('installs the expected migration indexes and state constraints', () => {
    const db = freshDb();
    const indexes = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'flow_run_admissions'",
      )
      .all() as { name: string }[];
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'flow_run_admissions_queue_idx',
        'flow_run_admissions_occupied_idx',
        'flow_run_admissions_live_ticket_idx',
        'flow_run_admissions_settled_idx',
        'flow_run_admissions_live_run_uniq',
      ]),
    );
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO flow_run_admissions (flow_run_id, state, priority_class, intent_version, intent_json, requested_at) VALUES ('missing', 'invalid', 'start', 1, '{}', 1)",
        )
        .run(),
    ).toThrow();
  });
});
