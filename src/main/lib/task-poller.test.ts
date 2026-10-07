/* eslint-disable project-structure/folder-structure -- co-located test for the grandfathered
   root module task-poller.ts; relocate together when that module gets a lib domain. */
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimTask as realClaimTask,
  createTask,
  getPendingTaskIds as realGetPendingTaskIds,
} from './db/repos/tasks';
import { freshDb, type TestDb } from './db/test-utils/fresh-db';
import { TaskPoller, type TaskPollerDeps } from './task-poller';

// Shape of a node:sqlite failure (the live driver), e.g. SQLITE_BUSY.
function sqliteBusyError(): Error {
  return Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
    errstr: 'database is locked',
  });
}

// Real repo functions over an in-memory DB, wrapped in spies so tests can force failures.
function makeDeps(db: TestDb) {
  return {
    getDatabase: vi.fn<TaskPollerDeps['getDatabase']>(() => db),
    getPendingTaskIds: vi.fn(realGetPendingTaskIds),
    claimTask: vi.fn(realClaimTask),
    log: { warn: vi.fn(), error: vi.fn() },
  } satisfies TaskPollerDeps;
}

describe('TaskPoller', () => {
  let db: TestDb;
  let deps: ReturnType<typeof makeDeps>;
  let poller: TaskPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    db = freshDb();
    deps = makeDeps(db);
    // No jitter: backoff is exactly 10s, 20s, then capped at 30s.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    poller = new TaskPoller(deps);
  });

  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts, polls, and claims a pending task with the hostname label', async () => {
    const task = await createTask(db, { description: 'queued work', source: 'manual' });

    const claimed = vi.fn();
    poller.on('task:claimed', claimed);
    await poller.start();

    expect(poller.isRunning()).toBe(true);
    expect(claimed).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id, status: 'running', executedBy: hostname() }),
    );
  });

  it('backs off exponentially when the pending-task query fails with a SQLite error', async () => {
    const error = sqliteBusyError();
    deps.getPendingTaskIds.mockRejectedValue(error);
    const onError = vi.fn();
    poller.on('task:error', onError);

    await poller.start(); // t=0: fails, backs off 10s
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
    expect(deps.log.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000); // t=5s: still backing off
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000); // t=10s: retries, fails, backs off 20s
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15000); // t=25s: still backing off
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000); // t=30s: retries
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(3);
  });

  it('resets the backoff after a successful poll', async () => {
    deps.getPendingTaskIds
      .mockRejectedValueOnce(sqliteBusyError()) // t=0  -> back off until 10s
      .mockRejectedValueOnce(sqliteBusyError()) // t=10 -> back off until 30s
      .mockResolvedValueOnce([]) // t=30 -> reset
      .mockRejectedValue(sqliteBusyError()); // t=35 -> back off 10s again (not 30s)

    await poller.start();
    await vi.advanceTimersByTimeAsync(35000);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(5000); // t=40s: backing off
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(5000); // t=45s: a fresh 10s backoff has elapsed
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(5);
  });

  it('backs off when opening the database throws', async () => {
    deps.getDatabase.mockImplementationOnce(() => {
      throw new Error('migration failed');
    });
    const onError = vi.fn();
    poller.on('task:error', onError);

    await poller.start(); // t=0: getDatabase throws, backs off 10s
    expect(onError).toHaveBeenCalledTimes(1);
    expect(deps.getPendingTaskIds).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.getPendingTaskIds).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000); // t=10s: polling resumes
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);
  });

  it('caps the pre-jitter delay at 30s however long the database stays down', async () => {
    deps.getPendingTaskIds.mockRejectedValue(sqliteBusyError());

    await poller.start(); // failures at t=0, 10, 30, 60, 90, 120
    await vi.advanceTimersByTimeAsync(120000);

    expect(deps.log.warn.mock.calls.map(([, meta]) => meta)).toEqual(
      [10000, 20000, 30000, 30000, 30000, 30000].map((retryInMs, i) => ({
        consecutiveFailures: Math.min(i + 1, 6),
        retryInMs,
      })),
    );
  });

  it('retries at most 35s apart with worst-case jitter (31s delay, then the next 5s tick)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999); // +999ms jitter on every backoff
    deps.getPendingTaskIds.mockRejectedValue(sqliteBusyError());

    await poller.start(); // retries land on ticks t=15, 40, 75, 110
    await vi.advanceTimersByTimeAsync(74000);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000); // t=75s: 35s after the t=40 attempt
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(4);

    expect(deps.log.warn.mock.calls.map(([, meta]) => meta.retryInMs)).toEqual([
      10999, 20999, 30999, 30999,
    ]);
  });

  it('does not let pokeNow() or resume() bypass an active backoff', async () => {
    deps.getPendingTaskIds.mockRejectedValue(sqliteBusyError());

    await poller.start(); // t=0: fails, backs off until 10s
    // A batch flow dispatches many agent nodes at once, each calling pokeNow().
    for (let i = 0; i < 5; i++) poller.pokeNow();
    poller.pause();
    poller.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);
  });

  it('runs one query when concurrent pokes land while a poll is in flight', async () => {
    let release: (rows: { id: string }[]) => void = () => {};
    deps.getPendingTaskIds.mockResolvedValueOnce([]).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    deps.getPendingTaskIds.mockResolvedValue([]);

    await poller.start();
    poller.pokeNow(); // in flight
    for (let i = 0; i < 5; i++) poller.pokeNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);

    release([]);
    await vi.advanceTimersByTimeAsync(0);
    poller.pokeNow(); // the guard is released after the in-flight poll settles
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(3);
  });

  it('keeps polling with backoff when a task:error listener always throws', async () => {
    deps.getPendingTaskIds.mockRejectedValue(sqliteBusyError());
    poller.on('task:error', () => {
      throw new Error('listener bug');
    });

    await expect(poller.start()).resolves.toBeUndefined();
    expect(poller.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(5000); // still backing off
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000); // t=10s: the loop survived and retries
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });

  it('keeps polling when a poll:start listener throws', async () => {
    deps.getPendingTaskIds.mockResolvedValue([]);
    poller.on('poll:start', () => {
      throw new Error('listener bug');
    });

    await expect(poller.start()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);

    expect(poller.isRunning()).toBe(true);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });

  it('backs off when a non-Error value is thrown', async () => {
    deps.getPendingTaskIds.mockRejectedValue('database is locked');
    const onError = vi.fn();
    poller.on('task:error', onError);

    await poller.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(onError).toHaveBeenCalledWith('database is locked');
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['backwards', '2026-10-01T12:00:00Z'],
    ['forwards', '2026-10-03T12:00:00Z'],
  ])('keeps the backoff unchanged when the wall clock jumps %s', async (_direction, jumpTo) => {
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    deps.getPendingTaskIds.mockRejectedValueOnce(sqliteBusyError()).mockResolvedValue([]);

    await poller.start(); // fails, backs off 10s
    // NTP correction / manual clock change after the backoff was scheduled.
    vi.setSystemTime(new Date(jumpTo));

    await vi.advanceTimersByTimeAsync(5000); // neither stalled nor cut short
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000); // t=10s: the backoff elapsed on schedule
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially when claiming a task keeps failing', async () => {
    await createTask(db, { description: 'queued work', source: 'manual' });
    const error = sqliteBusyError();
    deps.claimTask.mockRejectedValue(error);
    const onError = vi.fn();
    poller.on('task:error', onError);

    await poller.start(); // t=0: read ok, claim fails, backs off 10s
    expect(onError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ id: expect.any(String) }),
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.claimTask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000); // t=10s: retries, fails again, backs off 20s
    expect(deps.claimTask).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15000); // t=25s: the successful read did not reset it
    expect(deps.claimTask).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000); // t=30s
    expect(deps.claimTask).toHaveBeenCalledTimes(3);
  });
});
