import type { BackgroundTaskSummary, SessionCronSummary } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sentry from '../../sentry/init';
import { retireRetainedSession } from '../claude-session-registry';
import type { StopPendingWork, TaskStopHook } from '../../task-stop-hook';
import {
  logAdoptedTurnEnd,
  logDroppedPendingWork,
  summarizePendingWork,
  turnEndMustDispose,
} from './wake-hold-signal';

const shellTask: BackgroundTaskSummary = {
  id: 't1',
  type: 'shell',
  status: 'running',
  description: 'Full test suite with coverage',
  command: 'bun run test:run:coverage',
};
const cron: SessionCronSummary = {
  id: 'c1',
  schedule: '0 9 * * 1-5',
  recurring: true,
  prompt: 'check the deploy',
};
const pendingWork: StopPendingWork = { backgroundTasks: [shellTask], sessionCrons: [] };

// Spies, not module mocks: vitest.setup.ts already replaces both modules with noops, so these only
// record what a teardown reported.
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
let alert: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(log, 'warn');
  info = vi.spyOn(log, 'info');
  alert = vi.spyOn(sentry, 'captureMainMessage');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logDroppedPendingWork', () => {
  it('says nothing when the teardown dropped no harness work', () => {
    logDroppedPendingWork('c1', null, 'user-pause');

    expect(warn).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('names the cause and every dropped task kind in the log', () => {
    logDroppedPendingWork(
      'c2',
      { backgroundTasks: [shellTask], sessionCrons: [cron] },
      'user-pause',
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(user-pause)'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping: shell, cron'));
  });

  it('does not alert on a teardown the user asked for', () => {
    for (const cause of ['user-pause', 'remote-stop', 'aborted', 'chat archived (batch)']) {
      logDroppedPendingWork('c3', pendingWork, cause);
    }

    expect(warn).toHaveBeenCalledTimes(4);
    expect(alert).not.toHaveBeenCalled();
  });

  it('alerts on a teardown nobody asked for, whether prefixed or not', () => {
    const causes = [
      'session busy',
      'provider-switch:codex',
      'wake-pump-exit:sink-error',
      'successor cannot adopt Flow wake runtime slot',
    ];
    for (const cause of causes) logDroppedPendingWork('c4', pendingWork, cause);

    expect(alert).toHaveBeenCalledTimes(4);
    expect(alert).toHaveBeenLastCalledWith(
      'Session disposed with pending background work',
      'warning',
      { subChatId: 'c4', cause: causes[3], kinds: 'shell' },
    );
  });

  it('reports task kinds only — never a command, description or cron prompt', () => {
    logDroppedPendingWork(
      'c8',
      { backgroundTasks: [shellTask], sessionCrons: [cron] },
      'session busy',
    );

    const reported = JSON.stringify([warn.mock.calls, alert.mock.calls]);
    for (const secret of [shellTask.command, shellTask.description, cron.prompt]) {
      expect(reported).not.toContain(secret);
    }
  });

  it('reads a renderer teardown through the shared involuntary-reason classifier', () => {
    logDroppedPendingWork('c5', pendingWork, 'renderer-lifecycle:renderer-reload');
    logDroppedPendingWork('c5', pendingWork, 'renderer-lifecycle:renderer-crashed');

    expect(alert).toHaveBeenCalledTimes(2);
  });
});

type Gate = {
  aborted?: boolean;
  planHalted?: boolean;
  killed?: boolean;
  busy?: boolean;
  fenced?: boolean;
};

/** Ends `turn` through the gate on a session whose Stop hook last reported `work`. */
function endTurn(
  work: StopPendingWork | null,
  { aborted, planHalted, killed, busy, fenced }: Gate = {},
  turn: { adoptedHold?: boolean } = {},
  stoppedSinceReset = true,
): boolean {
  const controller = new AbortController();
  if (aborted) controller.abort();
  const stopHook = { lastPendingWork: work, stoppedSinceReset } as unknown as TaskStopHook;
  const fence = fenced && { subChatId: 'c6', inputsReadAt: 0 };
  const session = { stopHook, queue: { closed: !!killed }, busy: !!busy, ...fence };
  return turnEndMustDispose(
    'c6',
    session as Parameters<typeof turnEndMustDispose>[1],
    Object.assign(turn, { planSubmissionHalt: () => !!planHalted }),
    controller.signal,
  );
}

describe('turnEndMustDispose', () => {
  it('names the gate branch that fired', () => {
    expect(endTurn(pendingWork, { planHalted: true })).toBe(true);
    expect(endTurn(pendingWork, { killed: true })).toBe(true);
    expect(endTurn(pendingWork, { busy: true })).toBe(true);

    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('(plan submitted)'));
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('(question-park kill)'));
    expect(warn).toHaveBeenNthCalledWith(3, expect.stringContaining('(session busy)'));
    expect(alert).toHaveBeenCalledTimes(3);
  });

  it('keeps a submitted plan with nothing pending, for its approval to claim', () => {
    expect(endTurn(null, { planHalted: true })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the user's own stop out of Sentry", () => {
    expect(endTurn(pendingWork, { aborted: true })).toBe(true);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(aborted)'));
    expect(alert).not.toHaveBeenCalled();
  });

  it('ends a session whose chat switched account mid-turn, without an alert', () => {
    retireRetainedSession('c6', 'credential-change');

    expect(endTurn(pendingWork, { fenced: true })).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(credential-change)'));
    expect(alert).not.toHaveBeenCalled();
  });

  it('keeps an ordinary turn silent unless it drops work', () => {
    expect(endTurn(pendingWork)).toBe(false);
    expect(endTurn(null)).toBe(false);

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, StopPendingWork | null, Gate, boolean]>([
    [
      're-armed (Command, Scheduled wake)',
      { backgroundTasks: [shellTask], sessionCrons: [cron] },
      {},
      true,
    ],
    ['not re-armed (no pending work)', null, {}, true],
    ['not re-armed (no Stop snapshot)', null, {}, false],
    ['disposed (plan submitted)', pendingWork, { planHalted: true }, true],
  ])('logs an adopted turn once: %s', (disposition, work, gate, stopped) => {
    const turn = { adoptedHold: true };
    endTurn(work, gate, turn, stopped);
    logAdoptedTurnEnd(turn, 'c6', 'failed');

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      `[Socket Executor] Adopted turn ended for c6: ${disposition}`,
    );
  });
});

describe('summarizePendingWork', () => {
  const task = (id: string, type: string, extra: Partial<BackgroundTaskSummary> = {}) => ({
    id,
    type,
    status: 'running',
    description: `${id} work`,
    ...extra,
  });

  it('publishes each item with what the list needs to show and stop it', () => {
    const work: StopPendingWork = {
      backgroundTasks: [
        task('s1', 'shell', { command: 'bun test' }),
        task('w1', 'workflow', { name: 'review-pr' }),
        task('a1', 'subagent'),
        task('m1', 'monitor'),
      ],
      sessionCrons: [cron],
    };

    expect(summarizePendingWork(work).waitingOn).toEqual([
      { id: 's1', label: 'Command', description: 's1 work', command: 'bun test', stoppable: true },
      { id: 'w1', label: 'Workflow', description: 'review-pr', stoppable: true },
      { id: 'a1', label: 'Agent', description: 'a1 work', stoppable: true },
      { id: 'm1', label: 'Monitor', description: 'm1 work', stoppable: false },
      { id: cron.id, label: 'Scheduled wake', description: cron.prompt, stoppable: false },
    ]);
  });

  // `type` is unbounded: an unknown kind must not reach the UI verbatim or be offered a stop, and
  // prototype names would resolve to inherited members on an object-literal lookup.
  it.each(['some_future_kind', 'constructor', 'toString', '__proto__'])(
    'labels a %s-typed task neutrally and never offers to stop it',
    (type) => {
      const [item] = summarizePendingWork({
        backgroundTasks: [task('x1', type)],
        sessionCrons: [],
      }).waitingOn;
      expect(item).toMatchObject({ label: 'Background task', stoppable: false });
    },
  );
});
