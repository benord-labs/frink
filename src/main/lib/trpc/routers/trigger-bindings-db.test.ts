import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flows } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import type { Context } from '../index';

type DbRef = { current: TestDb | null };
const dbRef = vi.hoisted((): DbRef => ({ current: null }));

vi.mock('../../db', () => ({
  getDatabase: vi.fn(() => dbRef.current),
}));

import { triggerBindingsRouter } from './trigger-bindings';

const caller = triggerBindingsRouter.createCaller({ getWindow: () => null } satisfies Context);
const flowId = 'flow-sc-3296';

const createPostTaskBinding = () =>
  caller.create({ flowId, projectId: null, triggerType: 'post_task_trigger', config: {} });

describe('triggerBindingsRouter delete against real SQLite', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = freshDb();
    dbRef.current = db;
    await db.insert(flows).values({ id: flowId, name: 'Flow' });
  });

  it('a second delete of the same binding succeeds and the list stays empty', async () => {
    const binding = await createPostTaskBinding();

    await expect(caller.delete({ id: binding.id })).resolves.toEqual({ ok: true });
    await expect(caller.delete({ id: binding.id })).resolves.toEqual({ ok: true });
    await expect(caller.list({ flowId })).resolves.toEqual([]);
  });

  it('two concurrent deletes of the same binding (double-click) both succeed', async () => {
    const binding = await createPostTaskBinding();

    await expect(
      Promise.all([caller.delete({ id: binding.id }), caller.delete({ id: binding.id })]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);
    await expect(caller.list({ flowId })).resolves.toEqual([]);
  });

  it('a stale delete arriving after remove-and-re-add leaves the new binding intact', async () => {
    const original = await createPostTaskBinding();
    await caller.delete({ id: original.id });
    const replacement = await createPostTaskBinding();

    await expect(caller.delete({ id: original.id })).resolves.toEqual({ ok: true });
    const remaining = await caller.list({ flowId });
    expect(remaining.map((b) => b.id)).toEqual([replacement.id]);
  });

  it('succeeds when the binding vanished because its flow was deleted (cascade)', async () => {
    const binding = await createPostTaskBinding();
    await db.delete(flows);

    await expect(caller.delete({ id: binding.id })).resolves.toEqual({ ok: true });
  });
});
