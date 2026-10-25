import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NodeRunStatus } from '../../db/repos/node-runs';
import {
  chats,
  flowRunAdmissions,
  flowRuns,
  nodeRuns,
  subChats,
  type Task,
  tasks,
} from '../../db/schema';
import { seedActiveAdmission, seedFlowRun, seedFlowStep } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { beginFlowResourceActivity } from './activity';
import { humanWaitColdAt, releaseParkedSlot, slotlessPark } from './recovery-store';
import { countSlotsHeldByHumanWaits } from './visibility';

const GRAPH = { nodes: [{ id: 'step', blockType: 'agent' }], edges: [] };
const TASK_DONE_AT = new Date('2026-10-20T10:00:00Z');
const PARK_APPLIED_AT = new Date('2026-10-20T10:00:02Z');
const HOUR_MS = 60 * 60_000;
const COLD_AT = TASK_DONE_AT.getTime() + HOUR_MS;

let db: TestDb;
let flowRunId: string;

beforeEach(async () => {
  db = freshDb();
  ({ flowRunId } = await seedFlowRun(db, GRAPH));
  db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, flowRunId)).run();
  db.insert(chats).values({ id: 'chat-1' }).run();
  db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'session-1' }).run();
});

/** One agent step parked on a `needs_attention` task whose session answered it, park applied. */
async function parkStep(
  id = 'step',
  opts: {
    answered?: boolean;
    nodeStatus?: NodeRunStatus;
    taskStatus?: Task['status'];
    appliedAt?: Date;
    cacheExpiresAt?: number;
  } = {},
) {
  await seedFlowStep(
    db,
    flowRunId,
    id,
    opts.taskStatus ?? 'needs_attention',
    { status: opts.nodeStatus ?? 'blocked', completedAt: opts.appliedAt ?? PARK_APPLIED_AT },
    opts.answered ?? true,
  );
  const turnUsage = { promptCacheExpiresAt: opts.cacheExpiresAt };
  db.update(tasks)
    .set({ completedAt: TASK_DONE_AT, result: { chatId: 'chat-1', subChatId: 'sub-1', turnUsage } })
    .where(eq(tasks.id, `task-${id}`))
    .run();
}

describe('humanWaitColdAt', () => {
  it('holds for one agent step parked on a needs_attention task the watcher applied', async () => {
    await parkStep();
    expect(humanWaitColdAt(db, flowRunId)).toBe(COLD_AT);
  });

  it('goes cold when the last turn said its cache expires, never past an hour after it settled', async () => {
    const recorded = TASK_DONE_AT.getTime() + 5 * 60_000;
    await parkStep('step', { cacheExpiresAt: recorded });
    expect(humanWaitColdAt(db, flowRunId)).toBe(recorded);
    db.update(tasks)
      .set({
        result: { subChatId: 'sub-1', turnUsage: { promptCacheExpiresAt: COLD_AT + HOUR_MS } },
      })
      .run();
    expect(humanWaitColdAt(db, flowRunId)).toBe(COLD_AT);
  });

  it('refuses a run that is not paused, and a batch member', async () => {
    await parkStep();
    db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, flowRunId)).run();
    expect(humanWaitColdAt(db, flowRunId)).toBeNull();
    db.update(flowRuns)
      .set({ status: 'paused', batchId: 'batch-1' })
      .where(eq(flowRuns.id, flowRunId))
      .run();
    expect(humanWaitColdAt(db, flowRunId)).toBeNull();
  });

  it('keeps an agent hand-off: its task is still live', async () => {
    await parkStep('step', { nodeStatus: 'awaiting_input', taskStatus: 'running' });
    expect(humanWaitColdAt(db, flowRunId)).toBeNull();
  });

  it('waits until the watcher has applied the park', async () => {
    await parkStep('step', { appliedAt: new Date('2026-10-20T09:59:00Z') });
    expect(humanWaitColdAt(db, flowRunId)).toBeNull();
  });

  it('keeps a step whose session never answered, since a reply could not carry it on', async () => {
    await parkStep('step', { answered: false });
    expect(humanWaitColdAt(db, flowRunId)).toBeNull();
  });

  it('keeps an approval park, which has no task', async () => {
    db.insert(nodeRuns)
      .values({
        id: 'gate',
        flowRunId,
        nodeId: 'gate',
        blockType: 'approval',
        status: 'awaiting_input',
        completedAt: PARK_APPLIED_AT,
      })
      .run();
    expect(humanWaitColdAt(db, flowRunId)).toBeNull();
  });

  it('keeps a run with a second parked or live step', async () => {
    await parkStep();
    db.insert(nodeRuns)
      .values({ id: 'lane-2', flowRunId, nodeId: 'lane-2', blockType: 'agent', status: 'running' })
      .run();
    expect(humanWaitColdAt(db, flowRunId)).toBeNull();
  });
});

describe('releaseParkedSlot', () => {
  it('frees the active slot of a human wait in one step, and leaves any other paused run', async () => {
    const ticket = seedActiveAdmission(db, flowRunId);
    expect(releaseParkedSlot(db, ticket, COLD_AT)).toBeNull();
    await parkStep();
    expect(releaseParkedSlot(db, ticket, COLD_AT)).toEqual({ kind: 'released' });
    expect(db.select().from(flowRunAdmissions).get()).toMatchObject({ state: 'released' });
  });

  // A reply while the cache is warm carries on in the slot instead of queueing for a cold resume.
  it('keeps the slot until the prompt cache is cold', async () => {
    const ticket = seedActiveAdmission(db, flowRunId);
    await parkStep();
    expect(releaseParkedSlot(db, ticket, COLD_AT - 1)).toEqual({ kind: 'warm', coldAt: COLD_AT });
    expect(db.select().from(flowRunAdmissions).get()).toMatchObject({ state: 'active' });
  });

  // No release window: a live owner (a wake hold, a click) keeps the slot until its own release.
  it('keeps the slot while any activity on the run is still live', async () => {
    const ticket = seedActiveAdmission(db, flowRunId);
    await parkStep();
    const release = beginFlowResourceActivity(flowRunId);
    try {
      expect(releaseParkedSlot(db, ticket, COLD_AT)).toBeNull();
    } finally {
      release();
    }
    expect(db.select().from(flowRunAdmissions).get()).toMatchObject({ state: 'active' });
  });
});

describe('waiting-run visibility', () => {
  it('counts slots held by paused runs someone must act on, and spots a slot-less park', async () => {
    const ticket = seedActiveAdmission(db, flowRunId);
    await parkStep();
    expect(await countSlotsHeldByHumanWaits(db)).toBe(1);
    expect(slotlessPark(db, flowRunId, 'step')).toBeNull();

    db.update(flowRunAdmissions)
      .set({ state: 'released', settledAt: new Date() })
      .where(eq(flowRunAdmissions.ticket, ticket))
      .run();
    expect(await countSlotsHeldByHumanWaits(db)).toBe(0);
    expect(slotlessPark(db, flowRunId, 'step')).toBe('settled');

    db.insert(flowRunAdmissions)
      .values({
        flowRunId,
        state: 'queued',
        priorityClass: 'resume',
        intentVersion: 1,
        intentJson: { version: 1, action: 'resume', flow_run_id: flowRunId, node_run_id: 'step' },
      })
      .run();
    expect(slotlessPark(db, flowRunId, 'step')).toBe('queued');
  });
});
