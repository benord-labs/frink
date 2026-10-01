import { afterEach, describe, expect, it, vi } from 'vitest';

const holds = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../claude-wake-hold', () => ({ readWakeHolds: () => holds }));
vi.mock('../../../sentry/init', () => ({
  captureMainException: vi.fn(),
  captureMainMessage: vi.fn(),
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

import { stopBackgroundTask } from './stop-background-task';

const task = (id: string, type = 'shell') => ({ id, type, status: 'running', description: id });
const cron = { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check' };

function heldWith(backgroundTasks: unknown[], sessionCrons: unknown[] = []) {
  const hold = {
    retracted: false,
    settling: false,
    pump: { isEnded: () => false, settleIfWorkFinished: vi.fn() },
    setHeld: vi.fn(),
    session: {
      queue: { closed: false },
      query: { stopTask: vi.fn(async (_id: string) => {}) },
      stopHook: { lastPendingWork: { backgroundTasks, sessionCrons } as unknown },
    },
  };
  holds.set('sc1', hold);
  return hold;
}

const publishedIds = (hold: ReturnType<typeof heldWith>) =>
  (hold.setHeld.mock.calls.at(-1)?.[1] as { waitingOn: { id: string }[] }).waitingOn.map(
    (item) => item.id,
  );

afterEach(() => {
  holds.clear();
  vi.useRealTimers();
});

describe('stopBackgroundTask', () => {
  it('stops the task, forgets it and re-publishes what is still running', async () => {
    const hold = heldWith([task('s1'), task('w1', 'workflow')]);

    expect(await stopBackgroundTask('sc1', 's1')).toEqual({ ok: true });

    expect(hold.session.query.stopTask).toHaveBeenCalledWith('s1');
    expect(hold.session.stopHook.lastPendingWork).toEqual({
      backgroundTasks: [task('w1', 'workflow')],
      sessionCrons: [],
    });
    expect(hold.setHeld).toHaveBeenCalledWith(true, expect.anything());
    expect(publishedIds(hold)).toEqual(['w1']);
  });

  // Ending a wait from here would race a subagent's reaction turn, or close a task-linked chat with
  // no completion signal — the session Stop owns the last item.
  it('refuses the last pending item without touching it', async () => {
    const hold = heldWith([task('s1')]);

    expect(await stopBackgroundTask('sc1', 's1')).toEqual({ ok: false, reason: 'last' });
    expect(hold.session.query.stopTask).not.toHaveBeenCalled();
  });

  it('lets a scheduled wake keep the wait alive for the last task', async () => {
    const hold = heldWith([task('a1', 'subagent')], [cron]);

    expect(await stopBackgroundTask('sc1', 'a1')).toEqual({ ok: true });
    expect(publishedIds(hold)).toEqual(['c1']);
  });

  it('cannot empty the wait through two quick clicks', async () => {
    const hold = heldWith([task('s1'), task('s2')]);

    const [first, second] = await Promise.all([
      stopBackgroundTask('sc1', 's1'),
      stopBackgroundTask('sc1', 's2'),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: 'last' });
    expect(hold.session.query.stopTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no hold', () => holds.clear()],
    ['a retracted hold', (h: ReturnType<typeof heldWith>) => (h.retracted = true)],
    ['a settling hold', (h: ReturnType<typeof heldWith>) => (h.settling = true)],
    ['an ended pump', (h: ReturnType<typeof heldWith>) => (h.pump.isEnded = () => true)],
    ['closed input', (h: ReturnType<typeof heldWith>) => (h.session.queue.closed = true)],
  ])('refuses with %s', async (_case, spoil) => {
    const hold = heldWith([task('s1'), task('s2')]);
    spoil(hold);

    expect(await stopBackgroundTask('sc1', 's1')).toEqual({ ok: false, reason: 'ended' });
    expect(hold.session.query.stopTask).not.toHaveBeenCalled();
  });

  it('refuses a task it does not list, and a kind whose stop is unverified', async () => {
    const hold = heldWith([task('s1'), task('m1', 'monitor')]);

    expect(await stopBackgroundTask('sc1', 'gone')).toEqual({ ok: false, reason: 'ended' });
    expect(await stopBackgroundTask('sc1', 'm1')).toEqual({ ok: false, reason: 'ended' });
    expect(hold.session.query.stopTask).not.toHaveBeenCalled();
  });

  it('leaves a wait that moved on during the stop to its own publish', async () => {
    const hold = heldWith([task('s1'), task('s2')]);
    hold.session.query.stopTask.mockImplementation(async () => {
      hold.retracted = true; // e.g. a follow-up adopted the hold meanwhile
    });

    expect(await stopBackgroundTask('sc1', 's1')).toEqual({ ok: true });
    expect(hold.setHeld).not.toHaveBeenCalled();
    expect(hold.session.stopHook.lastPendingWork).toEqual({
      backgroundTasks: [task('s1'), task('s2')],
      sessionCrons: [],
    });
  });

  it('reports a CLI refusal and keeps listing the task', async () => {
    const hold = heldWith([task('s1'), task('s2')]);
    hold.session.query.stopTask.mockRejectedValue(new Error('Task s1 is not running'));

    expect(await stopBackgroundTask('sc1', 's1')).toEqual({
      ok: false,
      reason: 'failed',
      message: 'Task s1 is not running',
    });
    expect(hold.setHeld).not.toHaveBeenCalled();
  });

  // A timed-out stop can still land later, so the task keeps counting as gone until the CLI answers.
  it('keeps a timed-out stop in flight until the CLI answers, then forgets the task', async () => {
    vi.useFakeTimers();
    const hold = heldWith([task('s1'), task('s2')]);
    let answer = () => {};
    hold.session.query.stopTask.mockReturnValueOnce(new Promise<void>((r) => (answer = r)));

    const first = stopBackgroundTask('sc1', 's1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toEqual({ ok: false, reason: 'timeout' });
    expect(hold.setHeld).not.toHaveBeenCalled();
    expect(await stopBackgroundTask('sc1', 's2')).toEqual({ ok: false, reason: 'last' });

    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(publishedIds(hold)).toEqual(['s2']);
  });

  it('frees a failed stop at once', async () => {
    const hold = heldWith([task('s1'), task('s2')]);
    hold.session.query.stopTask.mockRejectedValueOnce(new Error('boom'));

    expect(await stopBackgroundTask('sc1', 's1')).toMatchObject({ ok: false, reason: 'failed' });
    expect(await stopBackgroundTask('sc1', 's2')).toEqual({ ok: true });
  });

  it('treats a synchronous SDK throw as a failed stop, and frees the task at once', async () => {
    const hold = heldWith([task('s1'), task('s2')]);
    hold.session.query.stopTask.mockImplementationOnce(() => {
      throw new Error('transport closed');
    });

    expect(await stopBackgroundTask('sc1', 's1')).toMatchObject({ ok: false, reason: 'failed' });
    expect(await stopBackgroundTask('sc1', 's2')).toEqual({ ok: true });
  });

  // While s1's stop is in flight s2 settles on its own and a burst's Stop rewrites the list to [s1].
  const racedToLast = (type: string) => {
    const hold = heldWith([task('s1', type), task('s2')]);
    hold.session.query.stopTask.mockImplementationOnce(async () => {
      hold.session.stopHook.lastPendingWork = {
        backgroundTasks: [task('s1', type)],
        sessionCrons: [],
      };
    });
    return hold;
  };

  it('ends the wait when a stopped shell turned out to be the last item, since no turn follows', async () => {
    const hold = racedToLast('shell');

    expect(await stopBackgroundTask('sc1', 's1')).toEqual({ ok: true });
    expect(hold.session.stopHook.lastPendingWork).toBeNull();
    expect(hold.pump.settleIfWorkFinished).toHaveBeenCalledTimes(1);
    expect(hold.setHeld).not.toHaveBeenCalled();
  });

  it('leaves a stopped subagent that turned out last to its own reaction turn', async () => {
    const hold = racedToLast('subagent');

    expect(await stopBackgroundTask('sc1', 's1')).toEqual({ ok: true });
    expect(hold.session.stopHook.lastPendingWork).toEqual({
      backgroundTasks: [task('s1', 'subagent')],
      sessionCrons: [],
    });
    expect(hold.pump.settleIfWorkFinished).not.toHaveBeenCalled();
  });

  it('joins a repeat stop of the same task instead of sending a second one', async () => {
    const hold = heldWith([task('s1'), task('s2'), task('s3')]);

    const [first, repeat] = await Promise.all([
      stopBackgroundTask('sc1', 's1'),
      stopBackgroundTask('sc1', 's1'),
    ]);

    expect(first).toEqual({ ok: true });
    expect(repeat).toEqual({ ok: true });
    expect(hold.session.query.stopTask).toHaveBeenCalledTimes(1);
  });
});
