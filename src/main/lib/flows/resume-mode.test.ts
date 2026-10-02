/**
 * resolveInterruptedResumeMode — WHICH mechanism the in-chat Resume row uses for a
 * restart-interrupted run. `session` sends a hidden wake down the chat pipe (the agent simply
 * continues); `redispatch` re-runs the step from its instructions and must be labelled as such.
 *
 * Pins the SEAM, not the arithmetic: the gate deliberately reuses the executor's own revive
 * predicate, so these cases are the ones where "the row offered Resume" and "a message can actually
 * wake it" could drift apart.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
import { getOrCreateFlowRunByIdempotencyKey, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import { createSubChat } from '../db/repos/sub-chats';
import { createTask, updateTaskStatus } from '../db/repos/tasks';
import { chats, subChatMessages } from '../db/schema';
import { seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));

// `session` is only legal while the run still holds its active admission slot (a wake continues
// the run without re-admitting). Controlled here instead of seeding real admission rows.
type AdmissionProbe = { active: boolean; queued: boolean; error: Error | null };
const admission = vi.hoisted((): AdmissionProbe => ({ active: true, queued: false, error: null }));
vi.mock('./admission/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admission/runtime')>()),
  hasActiveFlowAdmission: async () => {
    if (admission.error) throw admission.error;
    return admission.active;
  },
  probeFlowAdmission: async () => {
    if (admission.error) throw admission.error;
    return { active: admission.active, queuedResume: admission.queued };
  },
}));

import { describeInterruptedRunForChat, resolveInterruptedResumeMode } from './resume';

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

  it('wakes in place when the cancelled driving task and a session are both present', async () => {
    await seedDrivingTask(RUN_ID);
    expect(await resolveInterruptedResumeMode(RUN_ID, SUB_CHAT_ID)).toBe('session');
  });

  // The shared sub-chat's session is from earlier nodes; waking it would make the agent redo the
  // previous node and complete this one unrun.
  it("falls back to re-dispatch when the session never answered the interrupted node's prompt", async () => {
    await seedDrivingTask(RUN_ID, false);
    expect(await resolveInterruptedResumeMode(RUN_ID, SUB_CHAT_ID)).toBe('redispatch');
  });

  // No session id means the attempt died before the CLI produced a frame, so a follow-up would
  // replay the whole transcript — a re-run wearing a resume's clothes.
  it('falls back to re-dispatch when the sub-chat has no resumable session', async () => {
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

    expect(await resolveInterruptedResumeMode(RUN_ID, 'sc-sessionless')).toBe('redispatch');
  });

  // A settled admission ticket means the wake turn would be rejected at the provider preflight and
  // the failure park would strand the run `paused` with no slot — so the row must offer the
  // re-dispatch path, which re-admits via a durable resume ticket.
  it('reports queued while a resume ticket is already waiting for a slot — no button can help', async () => {
    await seedDrivingTask(RUN_ID);
    admission.active = false;
    admission.queued = true;
    expect(await resolveInterruptedResumeMode(RUN_ID, SUB_CHAT_ID)).toBe('queued');
    // Precedence over redispatch: a second enqueue would be refused even for a session-less tab.
    expect(await resolveInterruptedResumeMode(RUN_ID, 'sc-other')).toBe('queued');
  });

  it('falls back to re-dispatch when the run no longer holds its admission slot', async () => {
    await seedDrivingTask(RUN_ID);
    admission.active = false;

    expect(await resolveInterruptedResumeMode(RUN_ID, SUB_CHAT_ID)).toBe('redispatch');
  });

  // A probe failure (admission store not yet initialized when the renderer polls at boot) must
  // not reject the whole read — the recovery row would vanish. Redispatch never needs the probe.
  it('falls back to re-dispatch when the admission probe itself fails', async () => {
    await seedDrivingTask(RUN_ID);
    admission.error = new Error('admission store not started');

    expect(await resolveInterruptedResumeMode(RUN_ID, SUB_CHAT_ID)).toBe('redispatch');
  });

  // A run_command/http node swept by recoverOrphanedNodeRuns leaves the PRIOR agent node's `done`
  // task as the sub-chat's newest. A chat message would resume nothing, so the row must re-dispatch.
  it('falls back to re-dispatch when the interrupted node is not the one driving this sub-chat', async () => {
    const task = await createTask(db, {
      description: 'earlier agent step',
      source: 'flow',
      flowRunId: RUN_ID,
      result: { subChatId: SUB_CHAT_ID },
    });
    await updateTaskStatus(db, task.id, 'done', { result: { subChatId: SUB_CHAT_ID } });

    expect(await resolveInterruptedResumeMode(RUN_ID, SUB_CHAT_ID)).toBe('redispatch');
  });

  // The row is chat-scoped but the wake is sub-chat-scoped: a tab holding a DIFFERENT run's task
  // must not fire a message that does nothing to the interrupted run.
  it('falls back to re-dispatch when the cancelled task belongs to another run', async () => {
    await seedDrivingTask(OTHER_RUN_ID);
    expect(await resolveInterruptedResumeMode(RUN_ID, SUB_CHAT_ID)).toBe('redispatch');
  });

  it('falls back to re-dispatch when the sub-chat has no flow task at all', async () => {
    expect(await resolveInterruptedResumeMode(RUN_ID, SUB_CHAT_ID)).toBe('redispatch');
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

      expect(await describeInterruptedRunForChat('chat-1', SUB_CHAT_ID)).toEqual({
        runId,
        resumable: true,
        resumeMode: 'session',
      });
    });

    // The gate seen through the read the renderer consumes: losing the slot renames the row to
    // "Re-run step" (mode redispatch) — it must NOT make the row disappear (resumable stays true).
    it('keeps a slotless interrupted run resumable, via redispatch', async () => {
      const { runId, nodeRunId } = await seedCancelledRunForChat('k-slotless', true);
      await seedDrivingTask(runId, true, nodeRunId);
      admission.active = false;

      expect(await describeInterruptedRunForChat('chat-1', SUB_CHAT_ID)).toEqual({
        runId,
        resumable: true,
        resumeMode: 'redispatch',
      });
    });

    // A deliberate user cancel carries no marker: no row renders, so the mechanism is moot.
    it('marks a user-cancelled run non-resumable', async () => {
      const { runId, nodeRunId } = await seedCancelledRunForChat('k-stop', false);
      await seedDrivingTask(runId, true, nodeRunId);

      expect(await describeInterruptedRunForChat('chat-1', SUB_CHAT_ID)).toEqual({
        runId,
        resumable: false,
        resumeMode: 'redispatch',
      });
    });

    it('returns null while the run is still live (no row needed)', async () => {
      expect(await describeInterruptedRunForChat('chat-1', SUB_CHAT_ID)).toBeNull();
    });

    it('returns null for a chat with no flow run', async () => {
      expect(await describeInterruptedRunForChat('chat-absent', SUB_CHAT_ID)).toBeNull();
    });
  });
});
