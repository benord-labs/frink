import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskSignalPayload } from '../../../../../shared/types/task-signal';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { createTask, getTaskById, parseResultRecord, updateTaskStatus } from '../tasks';
import {
  listTasksHoldingQuestions,
  removeHeldQuestionMarker,
  setHeldQuestionMarker,
} from './held-question-marker';

const signal = (header: string): TaskSignalPayload => ({
  state: 'awaiting_input',
  summary: `Needs your input: ${header}`,
  questions: [
    {
      question: 'Which?',
      header,
      options: [{ label: 'A', description: 'Option A' }],
      multiSelect: false,
    },
  ],
  at: '2026-10-02T00:00:00.000Z',
});

describe('held-question marker atomic patches', () => {
  let db: TestDb;
  let taskId: string;

  const result = async () => parseResultRecord((await getTaskById(db, taskId))?.result);

  beforeEach(async () => {
    db = freshDb();
    taskId = (await createTask(db, { description: 'held', source: 'flow' })).id;
  });

  it('set records the signal under its toolUseId and keeps every other result key', async () => {
    await updateTaskStatus(db, taskId, 'running', { result: { subChatId: 'sc', startMode: 'x' } });

    expect(await setHeldQuestionMarker(db, taskId, 'toolu_1', signal('Scope'))).not.toBeNull();

    expect(await result()).toEqual({
      subChatId: 'sc',
      startMode: 'x',
      heldQuestions: { toolu_1: signal('Scope') },
    });
    expect(listTasksHoldingQuestions(db).map((t) => t.id)).toEqual([taskId]);
  });

  it('set matches nothing when the task is not running', async () => {
    expect(await setHeldQuestionMarker(db, taskId, 'toolu_1', signal('Scope'))).toBeNull();
    expect((await result()).heldQuestions).toBeUndefined();
  });

  it('remove clears only its own hold, and drops the container with the last one', async () => {
    await updateTaskStatus(db, taskId, 'running', { result: { subChatId: 'sc' } });
    await setHeldQuestionMarker(db, taskId, 'toolu_1', signal('One'));
    await setHeldQuestionMarker(db, taskId, 'toolu_2', signal('Two'));

    await removeHeldQuestionMarker(db, taskId, 'toolu_1');
    expect((await result()).heldQuestions).toEqual({ toolu_2: signal('Two') });

    await removeHeldQuestionMarker(db, taskId, 'toolu_2');
    expect(await result()).toEqual({ subChatId: 'sc' });
    expect(listTasksHoldingQuestions(db)).toEqual([]);
    expect(await removeHeldQuestionMarker(db, taskId, 'toolu_2')).toBeNull();
  });

  it('remove still applies after the task left running', async () => {
    await updateTaskStatus(db, taskId, 'running', { result: {} });
    await setHeldQuestionMarker(db, taskId, 'toolu_1', signal('One'));
    await updateTaskStatus(db, taskId, 'cancelled');

    expect(await removeHeldQuestionMarker(db, taskId, 'toolu_1')).not.toBeNull();
    expect((await result()).heldQuestions).toBeUndefined();
  });

  it('lists only running tasks', async () => {
    await updateTaskStatus(db, taskId, 'running', { result: {} });
    await setHeldQuestionMarker(db, taskId, 'toolu_1', signal('One'));
    await updateTaskStatus(db, taskId, 'needs_attention');
    expect(listTasksHoldingQuestions(db)).toEqual([]);
  });
});
