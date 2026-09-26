import type { BackgroundTaskSummary, SessionCronSummary } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sentry from '../../sentry/init';
import type { StopPendingWork } from '../../task-stop-hook';
import { logDisposedPendingWork, logDroppedPendingWork } from './wake-hold-signal';

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
let alert: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(log, 'warn');
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

describe('logDisposedPendingWork', () => {
  it('names the gate branch that fired', () => {
    logDisposedPendingWork('c6', pendingWork, { aborted: false, planHalted: true, killed: false });
    logDisposedPendingWork('c6', pendingWork, { aborted: false, planHalted: false, killed: true });
    logDisposedPendingWork('c6', pendingWork, { aborted: false, planHalted: false, killed: false });

    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('(plan submitted)'));
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('(question-park kill)'));
    expect(warn).toHaveBeenNthCalledWith(3, expect.stringContaining('(session busy)'));
    expect(alert).toHaveBeenCalledTimes(3);
  });

  it("keeps the user's own stop out of Sentry", () => {
    logDisposedPendingWork('c7', pendingWork, { aborted: true, planHalted: false, killed: false });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(aborted)'));
    expect(alert).not.toHaveBeenCalled();
  });
});
