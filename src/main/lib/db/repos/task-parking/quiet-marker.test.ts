import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { createTask, getTaskById, parseResultRecord, updateTaskStatus } from '../tasks';
import { removeQuietEndMarker, setQuietEndMarker } from './quiet-marker';

const MARKER_AT = '2026-07-20T00:00:00.000Z';

describe('quiet-marker atomic patches', () => {
  let db: TestDb;
  let taskId: string;

  beforeEach(async () => {
    db = freshDb();
    const task = await createTask(db, { description: 'quiet task', source: 'flow' });
    taskId = task.id;
  });

  it('set patches only the marker key on a running task', async () => {
    await updateTaskStatus(db, taskId, 'running', { result: { startMode: 'execute' } });

    const row = await setQuietEndMarker(db, taskId, MARKER_AT);

    expect(row?.id).toBe(taskId);
    const fresh = parseResultRecord((await getTaskById(db, taskId))?.result);
    expect(fresh).toMatchObject({ startMode: 'execute', quietEndedAt: MARKER_AT });
  });

  it('set matches nothing when the task is not running', async () => {
    expect(await setQuietEndMarker(db, taskId, MARKER_AT)).toBeNull();
    expect(parseResultRecord((await getTaskById(db, taskId))?.result).quietEndedAt).toBeUndefined();
  });

  it('remove deletes only the marker and matches nothing when no marker is present', async () => {
    await updateTaskStatus(db, taskId, 'running', {
      result: { startMode: 'execute', quietEndedAt: MARKER_AT },
    });

    const removed = await removeQuietEndMarker(db, taskId);

    expect(removed?.id).toBe(taskId);
    const fresh = parseResultRecord((await getTaskById(db, taskId))?.result);
    expect(fresh.startMode).toBe('execute');
    expect(fresh.quietEndedAt).toBeUndefined();
    expect(await removeQuietEndMarker(db, taskId)).toBeNull();
  });
});
