import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeTurnUsage, storedTurnUsageSchema } from '../../../../../shared/types/turn-usage';
import type { UIMessageChunk } from '../../../claude/types';
import * as dbModule from '../../../db';
import * as taskTurnUsage from '../../../db/repos/task-turn-usage';
import {
  createTask,
  getTaskById,
  parseResultRecord,
  updateTaskResult,
  updateTaskStatus,
} from '../../../db/repos/tasks';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { mapTaskToNodeOutput } from '../../../flows/signal-bridge';
import { lastFinishMetadata, stampTurnUsage } from '.';

let db: TestDb;
let taskId: string;

const compact = (id: string, state: string) => ({ type: 'data-compact', id, data: { state } });

async function result() {
  const task = await getTaskById(db, taskId);
  return parseResultRecord(task?.result ?? null);
}

/** What the node would output, or undefined when nothing was stamped. */
async function usage() {
  const stored = storedTurnUsageSchema.safeParse((await result()).turnUsage);
  return stored.success ? nodeTurnUsage(stored.data) : undefined;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  db = freshDb();
  vi.spyOn(dbModule, 'getDatabase').mockReturnValue(db);
  const task = await createTask(db, { description: 'agent node', source: 'flow' });
  await updateTaskStatus(db, task.id, 'running', { result: { subChatId: 'sub-chat-1' } });
  taskId = task.id;
});

describe('stampTurnUsage — what one turn reports', () => {
  it('counts only settled Claude compactions, once per card', async () => {
    const parts = [
      { type: 'text', text: 'hi' },
      compact('c1', 'output-available'),
      compact('c1', 'output-available'),
      compact('c2', 'output-error'),
      compact('c3', 'input-streaming'),
    ];
    await stampTurnUsage(taskId, 'm1', { contextTokens: 84_000 }, parts, true);
    expect(await usage()).toEqual({ contextTokens: 84_000, compactions: 1 });
  });

  it('reports zero compactions and zero tokens as numbers, not null', async () => {
    await stampTurnUsage(taskId, 'm1', { contextTokens: 0 }, [], true);
    expect(await usage()).toEqual({ contextTokens: 0, compactions: 0 });
  });

  it('leaves compactions null for a provider that cannot report them (Codex)', async () => {
    await stampTurnUsage(taskId, 'm1', { contextTokens: 52_000 }, [], false);
    expect(await usage()).toEqual({ contextTokens: 52_000, compactions: null });
  });

  it('reports null context for a provider with no usage (Cursor, Copilot) or a non-finite value', async () => {
    await stampTurnUsage(taskId, 'm1', undefined, [], false);
    expect(await usage()).toEqual({ contextTokens: null, compactions: null });
    await stampTurnUsage(taskId, 'm2', { contextTokens: Number.NaN }, [], false);
    expect(await usage()).toEqual({ contextTokens: null, compactions: null });
  });

  it('skips a turn with no linked task', async () => {
    const write = vi.spyOn(taskTurnUsage, 'patchTaskTurnUsage');
    await stampTurnUsage(null, 'm1', { contextTokens: 5 }, [], true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('stampTurnUsage — across one node', () => {
  it('keeps every other result key', async () => {
    await updateTaskResult(db, taskId, { subChatId: 'sub-chat-1', agentSignal: { state: 'done' } });
    await stampTurnUsage(taskId, 'm1', { contextTokens: 5 }, [], true);
    expect(await result()).toMatchObject({
      subChatId: 'sub-chat-1',
      agentSignal: { state: 'done' },
    });
  });

  // A wake burst re-stamps its whole message: the arming turn's compaction must not count twice.
  it('replaces a re-stamped message instead of adding it again', async () => {
    const arming = [compact('c1', 'output-available')];
    await stampTurnUsage(taskId, 'm1', { contextTokens: 90_000 }, arming, true);
    const burst = [...arming, compact('c2', 'output-available')];
    await stampTurnUsage(taskId, 'm1', { contextTokens: 40_000 }, burst, true);
    expect(await usage()).toEqual({ contextTokens: 40_000, compactions: 2 });
  });

  it('sums compactions across a parked node resumed as a new message', async () => {
    const first = [compact('a', 'output-available')];
    const second = [compact('b', 'output-available')];
    await stampTurnUsage(taskId, 'm1', { contextTokens: 90_000 }, first, true);
    await stampTurnUsage(taskId, 'm2', { contextTokens: 30_000 }, second, true);
    expect(await usage()).toEqual({ contextTokens: 30_000, compactions: 2 });
  });

  // A burst stamp and the turn's final stamp can overlap; a read-then-write would let the later
  // write drop the other message's count.
  it('keeps both counts when two stamps overlap', async () => {
    await Promise.all([
      stampTurnUsage(taskId, 'm1', { contextTokens: 10 }, [compact('a', 'output-available')], true),
      stampTurnUsage(taskId, 'm2', { contextTokens: 20 }, [compact('b', 'output-available')], true),
    ]);
    expect((await usage())?.compactions).toBe(2);
  });

  it('keeps the last known occupancy when a later turn reports none', async () => {
    await stampTurnUsage(taskId, 'm1', { contextTokens: 90_000 }, [], true);
    await stampTurnUsage(taskId, 'm2', undefined, [], true);
    expect(await usage()).toEqual({ contextTokens: 90_000, compactions: 0 });
  });

  // A wake burst refreshes the cache after the arming turn; a turn that reports no expiry (a pure
  // cache read, Codex) must not leave the older one to free the slot early.
  it("keeps only the newest turn's cache expiry", async () => {
    await stampTurnUsage(taskId, 'm1', { promptCacheExpiresAt: 1_000 }, [], true);
    expect((await result()).turnUsage).toMatchObject({ promptCacheExpiresAt: 1_000 });
    await stampTurnUsage(taskId, 'm2', { promptCacheExpiresAt: 2_000 }, [], true);
    expect((await result()).turnUsage).toMatchObject({ promptCacheExpiresAt: 2_000 });
    await stampTurnUsage(taskId, 'm3', { contextTokens: 5 }, [], false);
    expect((await result()).turnUsage).not.toHaveProperty('promptCacheExpiresAt');
  });

  // A burst can end before its un-park of a quiet-idle park lands; the signal that supersedes the
  // park keeps the result, so the burst's usage must already be on it.
  it('stamps a row still parked when its burst ends', async () => {
    await updateTaskStatus(db, taskId, 'needs_attention', { result: { quietEndedAt: 'x' } });
    await stampTurnUsage(taskId, 'm1', { contextTokens: 77_000 }, [], true);
    expect(await usage()).toMatchObject({ contextTokens: 77_000 });
  });

  it('writes nothing once the row is terminal', async () => {
    await updateTaskStatus(db, taskId, 'done', { result: {} });
    await stampTurnUsage(taskId, 'm1', { contextTokens: 5 }, [], true);
    expect(await usage()).toBeUndefined();
  });

  it('never throws when the write fails', async () => {
    vi.spyOn(taskTurnUsage, 'patchTaskTurnUsage').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      stampTurnUsage(taskId, 'm1', { contextTokens: 5 }, [], true),
    ).resolves.toBeUndefined();
  });
});

describe('lastFinishMetadata', () => {
  it('reads the last finish chunk, past an earlier one a failed resume left', () => {
    const chunks: UIMessageChunk[] = [
      { type: 'finish', messageMetadata: { contextTokens: 1 } },
      { type: 'text-delta', id: 't', delta: 'x' },
      { type: 'finish', messageMetadata: { contextTokens: 2 } },
    ];
    expect(lastFinishMetadata(chunks)).toEqual({ contextTokens: 2 });
    expect(lastFinishMetadata([])).toBeUndefined();
  });
});

describe('turn usage → agent node outputs', () => {
  async function finishNode() {
    const done = { ...(await result()), agentSignal: { state: 'done' } };
    await updateTaskStatus(db, taskId, 'done', { result: done });
    const task = await getTaskById(db, taskId);
    if (!task) throw new Error('task vanished');
    return mapTaskToNodeOutput(task);
  }

  it('exposes a Claude turn as {{previous.contextTokens}} / {{previous.compactions}}', async () => {
    const parts = [compact('c1', 'output-available')];
    await stampTurnUsage(taskId, 'm1', { contextTokens: 120_000 }, parts, true);
    const output = await finishNode();
    expect(output.status).toBe('completed');
    expect(output.outputs).toMatchObject({ contextTokens: 120_000, compactions: 1 });
    expect(output.outputs).not.toHaveProperty('compactionsByMessage');
  });

  it('exposes a Codex turn with an explicit null compaction count', async () => {
    await stampTurnUsage(taskId, 'm1', { contextTokens: 64_000 }, [], false);
    const output = await finishNode();
    expect(output.outputs).toMatchObject({ contextTokens: 64_000, compactions: null });
  });
});
