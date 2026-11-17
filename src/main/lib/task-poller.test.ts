/* eslint-disable project-structure/folder-structure -- co-located test for the grandfathered
   root module task-poller.ts; relocate together when that module gets a lib domain. */
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimTask as realClaimTask,
  createTask,
  getPendingTaskIds as realGetPendingTaskIds,
  getTaskById,
} from './db/repos/tasks';
import { freshDb, type TestDb } from './db/test-utils/fresh-db';
import { getTaskPoller, TaskPoller, type TaskPollerDeps } from './task-poller';

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

  it('does not query when poked before start', async () => {
    poller.pokeNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.isRunning()).toBe(false);
    expect(deps.getPendingTaskIds).not.toHaveBeenCalled();
  });

  it('reports an empty poll without claiming', async () => {
    const complete = vi.fn();
    poller.on('poll:complete', complete);

    await poller.start();

    expect(complete).toHaveBeenCalledWith(0);
    expect(deps.claimTask).not.toHaveBeenCalled();
  });

  it('asks for one pending task per poll and claims only that one', async () => {
    const first = await createTask(db, { description: 'first', source: 'manual' });
    // Task ids are time-based, and fake timers freeze the clock.
    vi.advanceTimersByTime(1);
    const second = await createTask(db, { description: 'second', source: 'manual' });

    await poller.start();

    expect(deps.getPendingTaskIds).toHaveBeenCalledWith(db, 1);
    expect(deps.claimTask).toHaveBeenCalledTimes(1);
    const statuses = [await getTaskById(db, first.id), await getTaskById(db, second.id)].map(
      (task) => task?.status,
    );
    expect(statuses.toSorted()).toEqual(['pending', 'running']);
  });

  it('does not emit task:claimed when the claim is lost', async () => {
    await createTask(db, { description: 'queued work', source: 'manual' });
    deps.claimTask.mockResolvedValueOnce(null);
    const claimed = vi.fn();
    const onError = vi.fn();
    poller.on('task:claimed', claimed);
    poller.on('task:error', onError);

    await poller.start();

    expect(deps.claimTask).toHaveBeenCalledTimes(1);
    expect(claimed).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes a throwing task:claimed listener to task:error without backing off', async () => {
    const task = await createTask(db, { description: 'queued work', source: 'manual' });
    const error = new Error('listener bug');
    const onError = vi.fn();
    poller.on('task:claimed', () => {
      throw error;
    });
    poller.on('task:error', onError);

    await poller.start();
    expect(onError).toHaveBeenCalledWith(error, { id: task.id });

    poller.pokeNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });

  it('does not start a second poll while a claim is still in flight', async () => {
    await createTask(db, { description: 'queued work', source: 'manual' });
    let release: (row: Awaited<ReturnType<typeof realClaimTask>>) => void = () => {};
    deps.claimTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const starting = poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.claimTask).toHaveBeenCalledTimes(1);

    poller.pokeNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);

    release(null);
    await starting;
    poller.pokeNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });

  it('hands every caller the same poller, so the executor hears what startup polls', () => {
    expect(getTaskPoller()).toBe(getTaskPoller());
  });

  it('does not poll again when start is called on a running poller', async () => {
    await poller.start();
    await poller.start();

    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);
  });

  it('polls on every interval tick until stopped', async () => {
    await poller.start();

    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);

    poller.stop();
    expect(poller.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(15000);
    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });

  it('skips interval ticks and pokes while paused, and a poke does not unpause', async () => {
    await poller.start();
    poller.pause();

    await vi.advanceTimersByTimeAsync(5000);
    poller.pokeNow();
    await vi.advanceTimersByTimeAsync(5000);

    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(1);
  });

  it('polls immediately on resume', async () => {
    await poller.start();
    poller.pause();

    poller.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });
});
