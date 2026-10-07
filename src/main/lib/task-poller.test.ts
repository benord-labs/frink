/* eslint-disable project-structure/folder-structure -- co-located test for the grandfathered
   root module task-poller.ts; relocate together when that module gets a lib domain. */
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ getDatabase: vi.fn(() => ({}) as unknown) }));

const repoMocks = vi.hoisted(() => ({
  claimTask: vi.fn(),
  getPendingTaskIds: vi.fn(),
}));

vi.mock('./db/repos/tasks', () => repoMocks);

import { getTaskPoller, TaskPoller } from './task-poller';

const POLL_INTERVAL_MS = 5000;
// One failure with Math.random pinned to 0.5: min(30000, 5000 * 2) + floor(0.5 * 1000).
const FIRST_BACKOFF_MS = 10500;

/** pokeNow(), resume() and interval ticks discard the poll promise, so let it settle. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('TaskPoller', () => {
  let poller: TaskPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    repoMocks.claimTask.mockReset();
    repoMocks.getPendingTaskIds.mockReset();
    repoMocks.getPendingTaskIds.mockResolvedValue([]);
    poller = new TaskPoller();
  });

  afterEach(() => {
    poller.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts, polls, and claims with the hostname label', async () => {
    repoMocks.getPendingTaskIds.mockResolvedValue([{ id: 't1' }]);
    repoMocks.claimTask.mockResolvedValue({ id: 't1', status: 'running' });
    const claimed = vi.fn();
    poller.on('task:claimed', claimed);

    await poller.start();

    expect(poller.isRunning()).toBe(true);
    expect(repoMocks.claimTask).toHaveBeenCalledWith(expect.anything(), 't1', hostname());
    expect(claimed).toHaveBeenCalledWith({ id: 't1', status: 'running' });
  });

  it('does not query when poked before start', async () => {
    poller.pokeNow();
    await flush();

    expect(poller.isRunning()).toBe(false);
    expect(repoMocks.getPendingTaskIds).not.toHaveBeenCalled();
  });

  describe('claiming', () => {
    it('reports an empty poll without claiming', async () => {
      const complete = vi.fn();
      poller.on('poll:complete', complete);

      await poller.start();

      expect(complete).toHaveBeenCalledWith(0);
      expect(repoMocks.claimTask).not.toHaveBeenCalled();
    });

    it('asks for one pending task and claims only the first', async () => {
      repoMocks.getPendingTaskIds.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
      repoMocks.claimTask.mockResolvedValue({ id: 't1', status: 'running' });

      await poller.start();

      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledWith(expect.anything(), 1);
      expect(repoMocks.claimTask).toHaveBeenCalledTimes(1);
      expect(repoMocks.claimTask).toHaveBeenCalledWith(expect.anything(), 't1', hostname());
    });

    it('does not emit task:claimed when the claim is lost', async () => {
      repoMocks.getPendingTaskIds.mockResolvedValue([{ id: 't1' }]);
      repoMocks.claimTask.mockResolvedValue(null);
      const claimed = vi.fn();
      const taskError = vi.fn();
      poller.on('task:claimed', claimed);
      poller.on('task:error', taskError);

      await poller.start();

      expect(repoMocks.claimTask).toHaveBeenCalledTimes(1);
      expect(claimed).not.toHaveBeenCalled();
      expect(taskError).not.toHaveBeenCalled();
    });

    it('emits task:error with the task when the claim rejects, then keeps polling', async () => {
      const error = new Error('claim failed');
      repoMocks.getPendingTaskIds.mockResolvedValue([{ id: 't1' }]);
      repoMocks.claimTask.mockRejectedValueOnce(error);
      const taskError = vi.fn();
      poller.on('task:error', taskError);

      await poller.start();

      expect(taskError).toHaveBeenCalledTimes(1);
      expect(taskError).toHaveBeenCalledWith(error, { id: 't1' });

      poller.pokeNow();
      await flush();

      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);
    });

    it('routes a throwing task:claimed listener to task:error, then keeps polling', async () => {
      const error = new Error('listener failed');
      repoMocks.getPendingTaskIds.mockResolvedValue([{ id: 't1' }]);
      repoMocks.claimTask.mockResolvedValue({ id: 't1', status: 'running' });
      const taskError = vi.fn();
      poller.on('task:claimed', () => {
        throw error;
      });
      poller.on('task:error', taskError);

      await poller.start();

      expect(taskError).toHaveBeenCalledWith(error, { id: 't1' });

      poller.pokeNow();
      await flush();

      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);
    });
  });

  describe('backoff', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    it('currently backs off silently when the pending query throws a TypeError', async () => {
      repoMocks.getPendingTaskIds.mockRejectedValueOnce(new TypeError('fetch failed'));
      const complete = vi.fn();
      const taskError = vi.fn();
      poller.on('poll:complete', complete);
      poller.on('task:error', taskError);

      await poller.start();

      expect(complete).toHaveBeenCalledWith(0);
      expect(taskError).not.toHaveBeenCalled();
    });

    it('skips polls inside the backoff window and queries again once it has passed', async () => {
      repoMocks.getPendingTaskIds.mockRejectedValueOnce(new TypeError('fetch failed'));
      await poller.start();

      // Covers the interval ticks at 5000ms and 10000ms as well as the poke.
      await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS - 1);
      poller.pokeNow();
      await flush();
      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      poller.pokeNow();
      await flush();
      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);
    });

    it('resets the backoff after a successful query', async () => {
      repoMocks.getPendingTaskIds.mockRejectedValueOnce(new TypeError('fetch failed'));
      await poller.start();
      await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS);
      poller.pokeNow();
      await flush();
      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);

      // A failure straight after a success gets the first window again, not a doubled one.
      repoMocks.getPendingTaskIds.mockRejectedValueOnce(new TypeError('fetch failed'));
      poller.pokeNow();
      await flush();
      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS - 1);
      poller.pokeNow();
      await flush();
      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(1);
      poller.pokeNow();
      await flush();
      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(4);
    });

    it('emits task:error without backing off for any other query error', async () => {
      const error = new Error('db unavailable');
      repoMocks.getPendingTaskIds.mockRejectedValueOnce(error);
      const taskError = vi.fn();
      poller.on('task:error', taskError);

      await poller.start();

      expect(taskError).toHaveBeenCalledTimes(1);
      expect(taskError).toHaveBeenCalledWith(error);

      poller.pokeNow();
      await flush();

      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);
    });
  });

  it('does not start a second poll while one is in flight', async () => {
    let resolvePending: (tasks: { id: string }[]) => void = () => {};
    repoMocks.getPendingTaskIds.mockReturnValueOnce(
      new Promise<{ id: string }[]>((resolve) => {
        resolvePending = resolve;
      }),
    );

    const starting = poller.start();
    poller.pokeNow();
    await flush();
    expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(1);

    resolvePending([]);
    await starting;
    poller.pokeNow();
    await flush();
    expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });

  it('does not start a second poll while a claim is still in flight', async () => {
    let resolveClaim: (task: { id: string; status: string } | null) => void = () => {};
    repoMocks.getPendingTaskIds.mockResolvedValue([{ id: 't1' }]);
    repoMocks.claimTask.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClaim = resolve;
      }),
    );

    const starting = poller.start();
    await flush();
    expect(repoMocks.claimTask).toHaveBeenCalledTimes(1);

    poller.pokeNow();
    await flush();
    expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(1);

    resolveClaim(null);
    await starting;
    poller.pokeNow();
    await flush();
    expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);
  });

  it('hands every caller the same poller, so the executor hears what startup polls', () => {
    expect(getTaskPoller()).toBe(getTaskPoller());
  });

  describe('interval', () => {
    it('does not poll again when start is called on a running poller', async () => {
      await poller.start();
      await poller.start();

      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(1);
    });

    it('polls on every interval tick until stopped', async () => {
      await poller.start();

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);

      poller.stop();
      expect(poller.isRunning()).toBe(false);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);
    });
  });

  describe('pause and resume', () => {
    it('skips interval ticks and pokes while paused, and a poke does not unpause', async () => {
      await poller.start();
      poller.pause();

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      poller.pokeNow();
      await flush();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(1);
    });

    it('polls immediately on resume', async () => {
      await poller.start();
      poller.pause();

      poller.resume();
      await flush();

      expect(repoMocks.getPendingTaskIds).toHaveBeenCalledTimes(2);
    });
  });
});
