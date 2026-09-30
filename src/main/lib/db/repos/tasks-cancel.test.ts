import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import {
  cancelTaskDetailed,
  createTask,
  getTaskById,
  type TaskStatus,
  updateTaskStatus,
} from './tasks';

describe('cancelTaskDetailed — atomic pre-image for the session stop (sc-3263)', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const taskIn = async (status: TaskStatus, result?: Record<string, unknown>) => {
    const t = await createTask(db, { description: 'agent', source: 'manual' });
    if (status !== 'pending') await updateTaskStatus(db, t.id, status, { result });
    return t;
  };

  it('returns the replaced row (subChatId intact) while the saved row is cancelled', async () => {
    const t = await taskIn('running', { chatId: 'c1', subChatId: 'sc1' });

    const { task, previous, reason } = await cancelTaskDetailed(db, t.id);

    expect(reason).toBeUndefined();
    expect(task).toMatchObject({ status: 'cancelled', result: { cancelled: true } });
    expect(previous).toMatchObject({ status: 'running', result: { subChatId: 'sc1' } });
    expect((await getTaskById(db, t.id))?.status).toBe('cancelled');
  });

  it.each(['pending', 'plan_ready', 'needs_attention'] as const)(
    'cancels a %s task and reports that exact prior status',
    async (status) => {
      const t = await taskIn(status);
      const { task, previous } = await cancelTaskDetailed(db, t.id);
      expect(task?.status).toBe('cancelled');
      expect(previous?.status).toBe(status);
    },
  );

  it('reflects a transition that landed before the cancel (pending → running), not a stale read', async () => {
    const t = await taskIn('pending');
    await updateTaskStatus(db, t.id, 'running', { result: { subChatId: 'sc-late' } });

    const { previous } = await cancelTaskDetailed(db, t.id);

    expect(previous).toMatchObject({ status: 'running', result: { subChatId: 'sc-late' } });
  });

  it.each(['done', 'completed', 'failed', 'cancelled'] as const)(
    'refuses a %s task as invalid_state and leaves it untouched',
    async (status) => {
      const t = await taskIn(status);
      const { task, previous, reason } = await cancelTaskDetailed(db, t.id);
      expect(task).toBeNull();
      expect(previous).toBeUndefined();
      expect(reason).toBe('invalid_state');
      expect((await getTaskById(db, t.id))?.status).toBe(status);
    },
  );

  it('reports not_found for an unknown id', () => {
    expect(cancelTaskDetailed(db, 'missing')).toEqual({ task: null, reason: 'not_found' });
  });

  it('nests inside a caller transaction, so the caller rolling back undoes the cancel', async () => {
    const t = await taskIn('running');

    expect(() =>
      db.transaction(
        () => {
          expect(cancelTaskDetailed(db, t.id).task?.status).toBe('cancelled');
          throw new Error('caller failed');
        },
        { behavior: 'immediate' },
      ),
    ).toThrow('caller failed');

    expect((await getTaskById(db, t.id))?.status).toBe('running');
  });
});
