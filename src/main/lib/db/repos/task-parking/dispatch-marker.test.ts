import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { createTask, getTaskById, parseResultRecord, updateTaskStatus } from '../tasks';
import {
  clearDispatchStartedMarker,
  isDispatchStarted,
  setDispatchRedeliveredMarker,
  setDispatchStartedMarker,
  undeliveredDispatchSince,
} from './dispatch-marker';

const DISPATCHED_AT = '2026-10-02T10:30:13.000Z';

describe('dispatch-marker atomic patches', () => {
  let db: TestDb;
  let taskId: string;

  beforeEach(async () => {
    db = freshDb();
    taskId = (await createTask(db, { description: 'flow step', source: 'flow' })).id;
  });

  it('stamps the start without touching the rest of the result', async () => {
    await updateTaskStatus(db, taskId, 'running', {
      result: { subChatId: 'sub', dispatchedAt: DISPATCHED_AT },
    });

    await setDispatchRedeliveredMarker(db, taskId, DISPATCHED_AT, '2026-10-02T10:40:20.000Z');
    await setDispatchStartedMarker(db, taskId, DISPATCHED_AT, '2026-10-02T10:41:00.000Z');

    expect(parseResultRecord((await getTaskById(db, taskId))?.result)).toEqual({
      subChatId: 'sub',
      dispatchedAt: DISPATCHED_AT,
      dispatchRedeliveredAt: '2026-10-02T10:40:20.000Z',
      dispatchStartedAt: '2026-10-02T10:41:00.000Z',
    });
  });

  it('records a redelivery only on the exact undelivered dispatch observed', async () => {
    await updateTaskStatus(db, taskId, 'running', {
      result: { dispatchedAt: '2026-10-02T11:00:00.000Z' },
    });
    // A re-claim replaced the dispatch the sweep saw.
    expect(await setDispatchRedeliveredMarker(db, taskId, DISPATCHED_AT)).toBeNull();

    await updateTaskStatus(db, taskId, 'running', {
      result: { dispatchedAt: DISPATCHED_AT, dispatchStartedAt: '2026-10-02T10:30:20.000Z' },
    });
    // The turn started meanwhile.
    expect(await setDispatchRedeliveredMarker(db, taskId, DISPATCHED_AT)).toBeNull();
  });

  it('matches nothing once the task is no longer running', async () => {
    expect(await setDispatchStartedMarker(db, taskId, DISPATCHED_AT)).toBeNull();
  });

  // Retries and re-claims reuse the task id: an earlier attempt's turn must not mark the new one.
  it('stamps a start only on the dispatch generation the turn delivered', async () => {
    await updateTaskStatus(db, taskId, 'running', {
      result: { dispatchedAt: '2026-10-02T11:00:00.000Z' },
    });

    expect(await setDispatchStartedMarker(db, taskId, DISPATCHED_AT)).toBeNull();
    expect(
      undeliveredDispatchSince((await getTaskById(db, taskId))?.result ?? null),
    ).not.toBeNull();
  });
});

describe('clearDispatchStartedMarker', () => {
  // Two sends of one attempt can race: the aborted one must not erase the live one's stamp.
  it("clears only the stamp it wrote, never a later turn's", async () => {
    const db = freshDb();
    const taskId = (await createTask(db, { description: 'flow step', source: 'flow' })).id;
    await updateTaskStatus(db, taskId, 'running', {
      result: { dispatchedAt: DISPATCHED_AT, dispatchStartedAt: '2026-10-02T10:30:30.000Z' },
    });

    expect(
      await clearDispatchStartedMarker(db, taskId, DISPATCHED_AT, '2026-10-02T10:30:20.000Z'),
    ).toBeNull();
    expect(
      await clearDispatchStartedMarker(db, taskId, DISPATCHED_AT, '2026-10-02T10:30:30.000Z'),
    ).not.toBeNull();
    expect(
      undeliveredDispatchSince((await getTaskById(db, taskId))?.result ?? null),
    ).not.toBeNull();
  });
});

describe('undeliveredDispatchSince', () => {
  it('is the dispatch time while no turn has started', () => {
    expect(undeliveredDispatchSince({ dispatchedAt: DISPATCHED_AT })).toBe(
      Date.parse(DISPATCHED_AT),
    );
  });

  it('is null once a turn started for this dispatch', () => {
    expect(
      undeliveredDispatchSince({
        dispatchedAt: DISPATCHED_AT,
        dispatchStartedAt: '2026-10-02T10:30:20.000Z',
      }),
    ).toBeNull();
  });

  // Wall clocks step backwards (manual change, NTP); a delivered step must not read as undelivered.
  it('counts a start stamped before the dispatch (clock stepped back) as delivered', () => {
    expect(
      undeliveredDispatchSince({
        dispatchedAt: DISPATCHED_AT,
        dispatchStartedAt: '2026-10-02T10:30:11.000Z',
      }),
    ).toBeNull();
  });

  it('fails open without a dispatch stamp', () => {
    expect(undeliveredDispatchSince({})).toBeNull();
    expect(undeliveredDispatchSince({ dispatchedAt: 'not a date' })).toBeNull();
  });
});

describe('isDispatchStarted', () => {
  it('needs a dispatch stamp and a start no older than it', () => {
    expect(isDispatchStarted({})).toBe(false);
    expect(isDispatchStarted({ dispatchedAt: DISPATCHED_AT })).toBe(false);
    expect(
      isDispatchStarted({ dispatchedAt: DISPATCHED_AT, dispatchStartedAt: DISPATCHED_AT }),
    ).toBe(true);
  });
});
