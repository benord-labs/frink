import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flows, flowTriggerBindings } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import type { Context } from '../index';

const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown } }));

vi.mock('../../db', () => ({
  getDatabase: vi.fn(() => dbRef.current),
}));

import { triggerBindingsRouter } from './trigger-bindings';

const caller = triggerBindingsRouter.createCaller({ getWindow: () => null } satisfies Context);
const flowId = 'flow-sc-3296';

const createPostTaskBinding = () =>
  caller.create({ flowId, projectId: 'proj-1', triggerType: 'post_task_trigger', config: {} });

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

describe('triggerBindingsRouter project requirement for post_task_trigger (sc-3299)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = freshDb();
    dbRef.current = db;
    await db.insert(flows).values({ id: flowId, name: 'Flow' });
  });

  it.each([null, '', '  '])('rejects a post_task_trigger with project %j', async (projectId) => {
    await expect(
      caller.create({ flowId, projectId, triggerType: 'post_task_trigger', config: {} }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.list({ flowId })).resolves.toEqual([]);
  });

  it('still accepts a schedule_trigger without a project', async () => {
    const binding = await caller.create({
      flowId,
      projectId: null,
      triggerType: 'schedule_trigger',
      config: {},
    });
    expect(binding.projectId).toBeNull();
  });

  it('refuses to re-activate a project-less binding copied by flow duplication', async () => {
    await db.insert(flowTriggerBindings).values({
      id: 'b-dup',
      flowId,
      projectId: null,
      triggerType: 'post_task_trigger',
      isActive: false,
    });

    await expect(caller.update({ id: 'b-dup', isActive: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const [row] = await caller.list({ flowId });
    expect(row.isActive).toBe(false);

    // "Sync config to binding" sends config + clearLastError; it must keep working on the bad row.
    await expect(
      caller.update({ id: 'b-dup', config: { triggerStates: ['done'] }, clearLastError: true }),
    ).resolves.toMatchObject({ config: { triggerStates: ['done'] } });
    await expect(caller.update({ id: 'b-dup', isActive: false })).resolves.toMatchObject({
      isActive: false,
    });
    await expect(caller.delete({ id: 'b-dup' })).resolves.toEqual({ ok: true });
  });

  // The guard must stay narrow: a project-less schedule binding is the normal row that
  // upsertScheduleBindingForFlow writes, and users toggle it off and on from the editor.
  it.each([
    { triggerType: 'schedule_trigger' as const, projectId: null },
    { triggerType: 'post_task_trigger' as const, projectId: 'proj-1' },
  ])('re-activates an inactive $triggerType with project $projectId', async (scope) => {
    await db.insert(flowTriggerBindings).values({ id: 'b-ok', flowId, ...scope, isActive: false });

    await expect(caller.update({ id: 'b-ok', isActive: true })).resolves.toMatchObject({
      isActive: true,
    });
  });

  it('still reports NOT_FOUND when re-activating a binding that does not exist', async () => {
    await expect(caller.update({ id: 'missing', isActive: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
