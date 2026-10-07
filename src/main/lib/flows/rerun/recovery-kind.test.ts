import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import { setFlowRunStatus } from '../../db/repos/flow-runs';
import { chats, nodeRuns, subChatMessages, subChats, tasks } from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import {
  resolveRecoveryKind,
  resolveRecoveryKinds,
  resolveRunRecoveries,
  stepRecoveryKind,
  resolveSettledRunRecoveries,
  withRecoveryKind,
} from './recovery-kind';
import { settledStopNodes } from '../transitions';

let db: TestDb;
let flowRunId: string;
let seq = 0;

beforeEach(async () => {
  db = freshDb();
  seq = 0;
  ({ flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] }));
  await db.insert(chats).values({ id: 'chat-1', name: 'chat' });
  await db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'sess-1' });
});

/** A task's prompt as the send pipeline persists it, optionally followed by the session's reply. */
async function seedDispatch(taskId: string, answered: boolean): Promise<void> {
  const prompt = {
    id: `u-${taskId}`,
    role: 'user',
    parts: [],
    metadata: { dispatchTaskId: taskId },
  };
  const reply = { id: `a-${taskId}`, role: 'assistant', parts: [] };
  for (const message of answered ? [prompt, reply] : [prompt]) {
    await db
      .insert(subChatMessages)
      .values({ subChatId: 'sub-1', seq: seq++, message: JSON.stringify(message) });
  }
}

type SeedTaskOpts = { nodeRunId?: string; answered?: boolean; continuation?: boolean };

async function seedTask(id: string, opts: SeedTaskOpts = {}) {
  const [task] = await db
    .insert(tasks)
    .values({
      id,
      description: id,
      source: opts.nodeRunId ? 'flow' : 'manual',
      status: 'failed',
      result: { subChatId: 'sub-1' },
      flowRunId: opts.nodeRunId ? flowRunId : null,
      sourceId: opts.nodeRunId ?? null,
      nodeRunId: opts.nodeRunId ?? null,
      triggerContext: opts.continuation ? { _config: { resumeSession: true } } : null,
    })
    .returning();
  if (opts.answered !== undefined) await seedDispatch(id, opts.answered);
  return task;
}

async function seedNodeRun(
  id: string,
  over: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  await db
    .insert(nodeRuns)
    .values({ id, flowRunId, nodeId: id, blockType: 'agent', status: 'failed', ...over });
  return id;
}

describe('resolveRecoveryKind', () => {
  it('continues a flow step whose live session answered its node', async () => {
    const task = await seedTask('t1', { nodeRunId: await seedNodeRun('a'), answered: true });
    expect(await resolveRecoveryKind(db, task)).toBe('continue');
  });

  it('retries a flow step whose prompt the session never answered', async () => {
    const task = await seedTask('t1', { nodeRunId: await seedNodeRun('a'), answered: false });
    expect(await resolveRecoveryKind(db, task)).toBe('retry');
  });

  // Flow nodes share one sub-chat: an earlier node's answered turn says nothing about this one.
  it("retries a flow step when the session's newest answer belongs to an earlier node", async () => {
    await seedTask('t-prev', { nodeRunId: await seedNodeRun('prev'), answered: true });
    const task = await seedTask('t1', { nodeRunId: await seedNodeRun('a') });
    expect(await resolveRecoveryKind(db, task)).toBe('retry');
  });

  // Two attempts of node `a`: the session answered the first, so only a continuation of it resumes.
  it('retries a fresh re-dispatch of a node an earlier attempt got answered', async () => {
    const first = await seedTask('t-first', { nodeRunId: await seedNodeRun('a'), answered: true });
    const retry = await seedTask('t-retry', {
      nodeRunId: await seedNodeRun('a2', { nodeId: 'a' }),
    });
    expect(resolveRecoveryKind(db, retry)).toBe('retry');
    expect(Object.fromEntries(resolveRecoveryKinds(db, [first, retry]))).toEqual({
      't-first': 'continue',
      't-retry': 'retry',
    });
  });

  it('continues an unsent continuation attempt of the node the session answered', async () => {
    await seedTask('t-first', { nodeRunId: await seedNodeRun('a'), answered: true });
    const nodeRunId = await seedNodeRun('a2', { nodeId: 'a' });
    const carryOn = await seedTask('t-carry', { nodeRunId, answered: false, continuation: true });
    expect(resolveRecoveryKind(db, carryOn)).toBe('continue');
  });

  it("retries once a rollback emptied the sub-chat's session", async () => {
    const task = await seedTask('t1', { nodeRunId: await seedNodeRun('a'), answered: true });
    await db.update(subChats).set({ sessionId: '' }).where(eq(subChats.id, 'sub-1'));
    expect(await resolveRecoveryKind(db, task)).toBe('retry');
  });

  it('reads the session and transcript in one transaction, so a rollback is never half-seen', async () => {
    const task = await seedTask('t1', { answered: true });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((command, config) => {
      db.update(subChats).set({ sessionId: '' }).where(eq(subChats.id, 'sub-1')).run();
      return transaction(command, config);
    });

    expect(resolveRecoveryKind(db, task)).toBe('retry');
  });

  it('continues a non-flow task its session answered', async () => {
    const task = await seedTask('t1', { answered: true });
    expect(await resolveRecoveryKind(db, task)).toBe('continue');
  });

  it('retries a non-flow task whose send failed before any reply', async () => {
    const task = await seedTask('t1', { answered: false });
    expect(await resolveRecoveryKind(db, task)).toBe('retry');
  });

  it('retries a non-flow task once a later task drove the same session', async () => {
    const task = await seedTask('t1', { answered: true });
    await seedTask('t2', { answered: true });
    expect(await resolveRecoveryKind(db, task)).toBe('retry');
  });

  // Transcript [A prompt, reply, B prompt]: B drove the session since, so A's answer is stale.
  it('retries an answered task once a later task sent the session its prompt', async () => {
    const task = await seedTask('t1', { answered: true });
    await seedTask('t2', { answered: false });
    expect(resolveRecoveryKind(db, task)).toBe('retry');
  });

  it('retries a task with no sub-chat', async () => {
    expect(await resolveRecoveryKind(db, { id: 'x', flowRunId: null, result: {} })).toBe('retry');
  });
});

// A Retry restart re-checks its kind in the transaction that writes it.
describe('withRecoveryKind', () => {
  it('skips the write when the session answers the task as the transaction begins', async () => {
    const task = await seedTask('t1', { answered: false });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((command, config) => {
      db.insert(subChatMessages)
        .values({
          subChatId: 'sub-1',
          seq: seq++,
          message: '{"id":"a1","role":"assistant","parts":[]}',
        })
        .run();
      return transaction(command, config);
    });
    const write = vi.fn(() => 'written');

    expect(withRecoveryKind(db, task.id, 'retry', write)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(withRecoveryKind(db, task.id, 'continue', write)).toBe('written');
  });
});

describe('stepRecoveryKind', () => {
  it("follows the step's task, and retries a step no task drove", async () => {
    await seedTask('t1', { nodeRunId: await seedNodeRun('a'), answered: true });
    expect(stepRecoveryKind(db, 'a')).toBe('continue');
    expect(stepRecoveryKind(db, await seedNodeRun('cmd', { blockType: 'run_command' }))).toBe(
      'retry',
    );
  });
});

describe('resolveRecoveryKinds', () => {
  it('resolves a mixed batch exactly as each task alone', async () => {
    const flowStep = await seedTask('t-flow', {
      nodeRunId: await seedNodeRun('a'),
      answered: true,
    });
    const manual = await seedTask('t-manual');
    const kinds = resolveRecoveryKinds(db, [
      flowStep,
      manual,
      { id: 'x', flowRunId: null, result: {} },
    ]);
    expect(Object.fromEntries(kinds)).toEqual({
      't-flow': 'continue',
      't-manual': 'retry',
      x: 'retry',
    });
  });
});

const MARKED = {
  status: 'cancelled',
  outputs: {},
  artifacts: [],
  durationMs: 0,
  error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
} as const;

describe('resolveRunRecoveries', () => {
  it("reports a restart-interrupted run's marked agent step", async () => {
    const nodeRunId = await seedNodeRun('a', { status: 'cancelled', nodeOutput: MARKED });
    await seedTask('t1', { nodeRunId, answered: true });
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    expect(await resolveRunRecoveries(db, { id: flowRunId, status: 'cancelled' })).toEqual([
      { nodeRunId, kind: 'continue', confirmSideEffects: false },
    ]);
  });

  it('looks past an attempt a retry superseded to the interrupted step', async () => {
    const nodeRunId = await seedNodeRun('a', { status: 'cancelled', nodeOutput: MARKED });
    await seedNodeRun('b', { status: 'superseded' });
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    expect(await resolveRunRecoveries(db, { id: flowRunId, status: 'cancelled' })).toEqual([
      { nodeRunId, kind: 'retry', confirmSideEffects: false },
    ]);
  });

  it('asks to confirm side effects for a started non-agent step of a paused run', async () => {
    await seedNodeRun('cmd', { blockType: 'run_command', startedAt: new Date() });
    expect(await resolveRunRecoveries(db, { id: flowRunId, status: 'paused' })).toEqual([
      { nodeRunId: 'cmd', kind: 'retry', confirmSideEffects: true },
    ]);
  });

  // Retry routes every actionable row through a session continuation keyed on its node, so each row
  // needs its own kind — not only the run's last unfinished step.
  it('resolves every actionable step of a paused run, not just the last one', async () => {
    const older = await seedNodeRun('a', { status: 'failed' });
    await seedTask('t-a', { nodeRunId: older, answered: true });
    await seedNodeRun('b', { status: 'blocked' });
    await seedNodeRun('done', { status: 'completed' });
    expect(await resolveRunRecoveries(db, { id: flowRunId, status: 'paused' })).toEqual([
      { nodeRunId: 'a', kind: 'continue', confirmSideEffects: false },
      { nodeRunId: 'b', kind: 'retry', confirmSideEffects: false },
    ]);
  });

  it("resolves a paused run from the caller's already-read steps", async () => {
    await seedNodeRun('a', { status: 'failed' });
    await seedNodeRun('b', { status: 'blocked' });
    const read = await db.select().from(nodeRuns).where(eq(nodeRuns.id, 'b'));
    expect(await resolveRunRecoveries(db, { id: flowRunId, status: 'paused' }, read)).toEqual([
      { nodeRunId: 'b', kind: 'retry', confirmSideEffects: false },
    ]);
  });

  it('has none for a user-cancelled run or a running run', async () => {
    await seedNodeRun('a', { status: 'cancelled' });
    expect(await resolveRunRecoveries(db, { id: flowRunId, status: 'cancelled' })).toEqual([]);
    await seedNodeRun('b', { status: 'failed' });
    expect(await resolveRunRecoveries(db, { id: flowRunId, status: 'running' })).toEqual([]);
  });
});

describe('resolveSettledRunRecoveries', () => {
  it("resolves each settled run's stopped step without loading the steps' output blobs", async () => {
    await seedNodeRun('a', {
      status: 'cancelled',
      nodeOutput: { ...MARKED, outputs: { log: 'x' } },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    const run = { id: flowRunId, status: 'cancelled' } as const;
    const [stopped] = settledStopNodes(db, [run]);
    expect(stopped.nodeOutput).toEqual({
      status: 'cancelled',
      error: { message: RESTART_INTERRUPTION_REASON },
    });
    expect(resolveSettledRunRecoveries(db, [run]).get(flowRunId)).toEqual({
      nodeRunId: 'a',
      kind: 'retry',
      confirmSideEffects: false,
    });
  });
});
