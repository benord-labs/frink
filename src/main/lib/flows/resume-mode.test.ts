/**
 * resolveInterruptedResumeMode — how the in-chat row recovers a restart-interrupted run; pins the
 * seam where "the row offered X" and "the click does X" could drift apart.
 */

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
import { getOrCreateFlowRunByIdempotencyKey, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import { createSubChat } from '../db/repos/sub-chats';
import { createTask, updateTaskStatus } from '../db/repos/tasks';
import { chats, subChatMessages, subChats } from '../db/schema';
import { seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));

// Whether a resume ticket already owns the run. Controlled here instead of seeding real admission rows.
type AdmissionProbe = { active: boolean; queued: boolean; live: boolean; error: Error | null };
const admission = vi.hoisted((): AdmissionProbe => ({
  active: true,
  queued: false,
  live: true,
  error: null,
}));
vi.mock('./admission/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admission/runtime')>()),
  hasActiveFlowAdmission: async () => {
    if (admission.error) throw admission.error;
    return admission.active;
  },
  probeFlowAdmission: async () => {
    if (admission.error) throw admission.error;
    return { active: admission.active, queuedResume: admission.queued, live: admission.live };
  },
}));

import {
  dropStagedContinuation,
  stageContinuationResume,
} from './admission/terminal-resume/continuation';
import { describeInterruptedRunForChat, resolveInterruptedResumeMode } from './resume';

const mode = async (flowRunId: string) =>
  (await resolveInterruptedResumeMode(flowRunId)).resumeMode;

const SUB_CHAT_ID = 'sc-1';

describe('resolveInterruptedResumeMode', () => {
  let db: TestDb;
  let versionId: string;
  let RUN_ID: string;
  let OTHER_RUN_ID: string;

  /** A second run on the same version — `chatId` links it via trigger_context, as a real run does. */
  const seedRun = async (idempotencyKey: string, chatId?: string) =>
    (
      await getOrCreateFlowRunByIdempotencyKey(db, {
        flowVersionId: versionId,
        status: 'running',
        triggerContext: chatId ? { chatId } : null,
        idempotencyKey,
        startedAt: new Date(),
      })
    ).run.id;

  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    admission.active = true;
    admission.queued = false;
    admission.live = true;
    admission.error = null;
    // One project/flow/version (the fixture's project path is fixed, so it seeds once); extra runs
    // ride the same version — these cases only care about distinct flow_run ids.
    const seeded = await seedFlowRun(db, { nodes: [], edges: [] }, { idempotencyKey: 'k1' });
    versionId = seeded.versionId;
    RUN_ID = seeded.flowRunId;
    OTHER_RUN_ID = await seedRun('k2');
    await db.insert(chats).values({ id: 'chat-1' });
    await createSubChat(db, {
      id: SUB_CHAT_ID,
      chatId: 'chat-1',
      name: 'main',
      sessionId: 'session-abc',
    });
  });

  /** The cancelled+marker driving task as the cancel sweep leaves it; `answered` seeds its prompt and
   * the session's reply, false models a prompt that never reached the chat. */
  const seedDrivingTask = async (flowRunId: string, answered = true, nodeRunId?: string) => {
    const sourceId =
      nodeRunId ?? (await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' })).id;
    const task = await createTask(db, {
      description: 'agent step',
      source: 'flow',
      sourceId,
      nodeRunId: sourceId,
      flowRunId,
      result: { subChatId: SUB_CHAT_ID },
    });
    await updateTaskStatus(db, task.id, 'cancelled', {
      result: { subChatId: SUB_CHAT_ID, cancelled: true },
    });
    if (answered) {
      const prompt = { id: 'u1', role: 'user', parts: [], metadata: { dispatchTaskId: task.id } };
      const reply = { id: 'a1', role: 'assistant', parts: [] };
      await db.insert(subChatMessages).values([
        { subChatId: SUB_CHAT_ID, seq: 0, message: JSON.stringify(prompt) },
        { subChatId: SUB_CHAT_ID, seq: 1, message: JSON.stringify(reply) },
      ]);
    }
    return task;
  };

  // Never an in-place wake: even while the run still holds its slot, Continue re-admits through a
  // resume ticket, which continues the answering session.
  it('continues through a resume ticket while the run still holds its admission slot', async () => {
    await seedDrivingTask(RUN_ID);
    expect(await mode(RUN_ID)).toBe('continue');
  });

  // The shared sub-chat's session is from earlier nodes; waking it would make the agent redo the
  // previous node and complete this one unrun.
  it("retries when the session never answered the interrupted node's prompt", async () => {
    await seedDrivingTask(RUN_ID, false);
    expect(await mode(RUN_ID)).toBe('retry');
  });

  // No session id means the attempt died before the CLI produced a frame, so a follow-up would
  // replay the whole transcript — a re-run wearing a resume's clothes.
  it('retries when the sub-chat has no resumable session', async () => {
    await createSubChat(db, {
      id: 'sc-sessionless',
      chatId: 'chat-1',
      name: 'other',
      sessionId: null,
    });
    const task = await createTask(db, {
      description: 'agent step',
      source: 'flow',
      flowRunId: RUN_ID,
      result: { subChatId: 'sc-sessionless' },
    });
    await updateTaskStatus(db, task.id, 'cancelled', {
      result: { subChatId: 'sc-sessionless', cancelled: true },
    });

    expect(await mode(RUN_ID)).toBe('retry');
  });

  it('reports queued while a resume ticket is already waiting for a slot — no button can help', async () => {
    await seedDrivingTask(RUN_ID);
    admission.active = false;
    admission.queued = true;
    expect(await mode(RUN_ID)).toBe('queued');
  });

  // A continuation staged behind the run's held slot (typed reply, boot carry-on, an earlier click)
  // lives only in memory, so the admission store cannot report it.
  it('reports queued while a continuation is staged behind the held slot', async () => {
    await seedDrivingTask(RUN_ID);
    stageContinuationResume({ flowRunId: RUN_ID, nodeRunId: 'n-1' }, () => {});
    try {
      expect(await mode(RUN_ID)).toBe('queued');
    } finally {
      dropStagedContinuation(RUN_ID);
    }
    expect(await mode(RUN_ID)).toBe('continue');
  });

  // No admission is left whose settle would fire the entry, so nothing ever will: waiting on it
  // would hide the only button until a restart. The click drops it and re-admits instead.
  it('offers Continue, not queued, for a staged continuation no admission will fire', async () => {
    await seedDrivingTask(RUN_ID);
    admission.active = false;
    admission.live = false;
    stageContinuationResume({ flowRunId: RUN_ID, nodeRunId: 'n-1' }, () => {});
    try {
      expect(await mode(RUN_ID)).toBe('continue');
    } finally {
      dropStagedContinuation(RUN_ID);
    }
  });

  // A settled admission ticket would fail a wake turn at provider preflight and strand the run
  // `paused`, so the row re-admits via a resume ticket that still continues the answering session.
  it('continues through a resume ticket when the run no longer holds its admission slot', async () => {
    await seedDrivingTask(RUN_ID);
    admission.active = false;

    expect(await mode(RUN_ID)).toBe('continue');
  });

  // A probe failure (admission store not yet initialized when the renderer polls at boot) must
  // not reject the whole read — the recovery row would vanish. A resume ticket never needs the probe.
  it('continues through a resume ticket when the admission probe itself fails', async () => {
    await seedDrivingTask(RUN_ID);
    admission.error = new Error('admission store not started');

    expect(await mode(RUN_ID)).toBe('continue');
  });

  // A run_command/http node swept by recoverOrphanedNodeRuns leaves the PRIOR agent node's `done`
  // task as the sub-chat's newest. A chat message would resume nothing, so the row must retry.
  it('retries when the interrupted node is not the one driving this sub-chat', async () => {
    const task = await createTask(db, {
      description: 'earlier agent step',
      source: 'flow',
      flowRunId: RUN_ID,
      result: { subChatId: SUB_CHAT_ID },
    });
    await updateTaskStatus(db, task.id, 'done', { result: { subChatId: SUB_CHAT_ID } });

    expect(await mode(RUN_ID)).toBe('retry');
  });

  // Another run's answered step says nothing about this run's resume target.
  it('retries when the cancelled task belongs to another run', async () => {
    await seedDrivingTask(OTHER_RUN_ID);
    expect(await mode(RUN_ID)).toBe('retry');
  });

  it('retries when the sub-chat has no flow task at all', async () => {
    expect(await mode(RUN_ID)).toBe('retry');
  });

  // A rollback empties the session id; an empty id has nothing to continue.
  it("retries when a rollback emptied the sub-chat's session", async () => {
    await seedDrivingTask(RUN_ID);
    await db.update(subChats).set({ sessionId: '' }).where(eq(subChats.id, SUB_CHAT_ID));
    expect(await mode(RUN_ID)).toBe('retry');
  });

  describe('confirmSideEffects', () => {
    const interrupt = (blockType: string, startedAt: Date | null) =>
      createNodeRun(db, { flowRunId: RUN_ID, nodeId: 'cmd', blockType, startedAt });

    it('is set when a started non-agent step must run again', async () => {
      const { id } = await interrupt('run_command', new Date());
      expect(await resolveInterruptedResumeMode(RUN_ID)).toEqual({
        resumeMode: 'retry',
        confirmSideEffects: true,
        nodeRunId: id,
      });
    });

    it('is clear for a non-agent step that never started', async () => {
      const { id } = await interrupt('http', null);
      expect(await resolveInterruptedResumeMode(RUN_ID)).toEqual({
        resumeMode: 'retry',
        confirmSideEffects: false,
        nodeRunId: id,
      });
    });

    it('is clear for an agent step, which a retry re-prompts rather than replays', async () => {
      const { id } = await interrupt('agent', new Date());
      expect(await resolveInterruptedResumeMode(RUN_ID)).toEqual({
        resumeMode: 'retry',
        confirmSideEffects: false,
        nodeRunId: id,
      });
    });
  });

  /**
   * The row's whole state in one read — what the tRPC proc returns verbatim. `null` means no row;
   * `resumable: false` means a deliberate user cancel, which renders nothing either.
   */
  describe('describeInterruptedRunForChat', () => {
    /**
     * A chat-linked run cancelled mid-agent-node, exactly as a restart leaves it: the node_run holds
     * the marker (`interrupted`), which is what tells a recoverable interruption from a user Stop.
     */
    const seedCancelledRunForChat = async (key: string, interrupted: boolean) => {
      const runId = await seedRun(key, 'chat-1');
      const nodeRun = await createNodeRun(db, {
        flowRunId: runId,
        nodeId: 'a',
        blockType: 'agent',
      });
      await setNodeRunStatus(db, nodeRun.id, 'cancelled', {
        completedAt: new Date(),
        nodeOutput: {
          status: 'cancelled',
          outputs: {},
          artifacts: [],
          durationMs: 0,
          ...(interrupted
            ? { error: { message: RESTART_INTERRUPTION_REASON, retryable: true } }
            : {}),
        },
      });
      await setFlowRunStatus(db, runId, 'cancelled');
      return { runId, nodeRunId: nodeRun.id };
    };

    it('reports the run, its resumability and the mechanism together', async () => {
      const { runId, nodeRunId } = await seedCancelledRunForChat('k-int', true);
      await seedDrivingTask(runId, true, nodeRunId);

      expect(await describeInterruptedRunForChat('chat-1')).toEqual({
        runId,
        resumable: true,
        resumeMode: 'continue',
        confirmSideEffects: false,
        nodeRunId,
      });
    });

    // Losing the slot must NOT make the row disappear (resumable stays true).
    it('keeps a slotless interrupted run resumable, via continue', async () => {
      const { runId, nodeRunId } = await seedCancelledRunForChat('k-slotless', true);
      await seedDrivingTask(runId, true, nodeRunId);
      admission.active = false;

      expect(await describeInterruptedRunForChat('chat-1')).toEqual({
        runId,
        resumable: true,
        resumeMode: 'continue',
        confirmSideEffects: false,
        nodeRunId,
      });
    });

    // A deliberate user cancel carries no marker: no row renders, so the mechanism is moot.
    it('marks a user-cancelled run non-resumable', async () => {
      const { runId, nodeRunId } = await seedCancelledRunForChat('k-stop', false);
      await seedDrivingTask(runId, true, nodeRunId);

      expect(await describeInterruptedRunForChat('chat-1')).toEqual({
        runId,
        resumable: false,
        resumeMode: 'retry',
        confirmSideEffects: false,
        nodeRunId: null,
      });
    });

    it('returns null while the run is still live (no row needed)', async () => {
      expect(await describeInterruptedRunForChat('chat-1')).toBeNull();
    });

    it('returns null for a chat with no flow run', async () => {
      expect(await describeInterruptedRunForChat('chat-absent')).toBeNull();
    });
  });
});
