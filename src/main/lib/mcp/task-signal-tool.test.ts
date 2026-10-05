import { beforeEach, describe, expect, it, vi } from 'vitest';

// sc-2771: the tool must not answer ok:true for a signal whose target can no longer consume it.
const state = vi.hoisted(() => ({
  getTaskById: vi.fn(),
  getFlowRun: vi.fn(),
  isSignalTargetDead: vi.fn(),
}));
vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('../db/repos/tasks', () => ({ getTaskById: state.getTaskById }));
vi.mock('../db/repos/flow-runs', () => ({ getFlowRun: state.getFlowRun }));
vi.mock('../socket/flow-signal', () => ({ isSignalTargetDead: state.isSignalTargetDead }));

import { handleTaskSignalToolCall, type TaskSignalToolContext } from './task-signal-tool';

const task = (status: string, result: Record<string, unknown> = {}) => ({
  id: 'task-1',
  status,
  flowRunId: 'run-1',
  result,
});
const contextFor = (signalTaskId: string | null = 'task-1'): TaskSignalToolContext => ({
  taskSignalEnabled: true,
  signalTaskId,
});
const DONE = { state: 'done', summary: 'Done' };

describe('handleTaskSignalToolCall — signal target check (sc-2771)', () => {
  beforeEach(() => {
    state.getTaskById.mockReset();
    state.getFlowRun.mockReset().mockResolvedValue(null);
    state.isSignalTargetDead.mockReset().mockResolvedValue(false);
  });

  it('accepts a signal on a live running task and says the flip applies at turn end', async () => {
    state.getTaskById.mockResolvedValue(task('running'));
    const ctx = contextFor();

    const result = await handleTaskSignalToolCall(ctx, DONE);

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: true,
      accepted: true,
      appliesAt: 'turn-end',
    });
    expect(ctx.latestTaskSignal?.state).toBe('done');
    expect(ctx.taskSignalEnabled).toBe(true);
  });

  it('records every accepted signal as a new object, even an identical repeat', async () => {
    // The Stop hook tells a stale drafting park from a later one by identity; an in-place update
    // would make every later signal look stale.
    state.getTaskById.mockResolvedValue(task('running'));
    const ctx = contextFor();
    const park = { state: 'awaiting_input', summary: 'Which API?' };

    await handleTaskSignalToolCall(ctx, park);
    const first = ctx.latestTaskSignal;
    await handleTaskSignalToolCall(ctx, park);

    expect(first).toBeDefined();
    expect(ctx.latestTaskSignal).not.toBe(first);
  });

  it('refuses a signal whose task or run can no longer consume it, and disarms the tool', async () => {
    state.getTaskById.mockResolvedValue(task('cancelled'));
    state.isSignalTargetDead.mockResolvedValue(true);
    state.getFlowRun.mockResolvedValue({ id: 'run-1', status: 'cancelled' });
    const ctx = contextFor();

    const result = await handleTaskSignalToolCall(ctx, DONE);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('is cancelled (flow run cancelled)');
    expect(result.content[0]?.text).toContain('will not advance');
    expect(ctx.latestTaskSignal).toBeUndefined();
    expect(ctx.taskSignalEnabled).toBe(false);
  });

  it.each([
    ['refuses a row that is not dead but cannot take a signal (plan_ready)', task('plan_ready'), true],
    // A lease-expired failure is still signalable — the agent's late `done` recovers the run.
    [
      'accepts a lease-expired failed task',
      task('failed', { failureCode: 'EXECUTION_LEASE_EXPIRED' }),
      false,
    ],
    ['refuses an ordinarily failed task', task('failed', { error: 'boom' }), true],
    // A parked task is superseded by the agent's real signal, so it stays signalable.
    ['accepts a parked (needs_attention) task', task('needs_attention'), false],
  ])('%s', async (_name, row, refused) => {
    state.getTaskById.mockResolvedValue(row);
    const ctx = contextFor();

    const result = await handleTaskSignalToolCall(ctx, DONE);

    expect(result.isError).toBe(refused);
    expect(ctx.latestTaskSignal?.state).toBe(refused ? undefined : 'done');
  });

  it('refuses when the target row is gone', async () => {
    state.getTaskById.mockResolvedValue(null);
    state.isSignalTargetDead.mockResolvedValue(true);

    const result = await handleTaskSignalToolCall(contextFor(), DONE);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no longer exists');
  });

  it('fails open when the target read throws', async () => {
    state.getTaskById.mockRejectedValue(new Error('SQLITE_BUSY'));
    const ctx = contextFor();

    expect((await handleTaskSignalToolCall(ctx, DONE)).isError).toBe(false);
    expect(ctx.latestTaskSignal?.state).toBe('done');
  });

  it('skips the check when no signal task is registered', async () => {
    const result = await handleTaskSignalToolCall(contextFor(null), DONE);

    expect(result.isError).toBe(false);
    expect(state.getTaskById).not.toHaveBeenCalled();
  });

  it('answers a repeat call after a refusal from the disarmed path, without re-reading the row', async () => {
    state.getTaskById.mockResolvedValue(task('cancelled'));
    state.isSignalTargetDead.mockResolvedValue(true);
    const ctx = contextFor();
    await handleTaskSignalToolCall(ctx, DONE);
    state.getTaskById.mockClear();

    const again = await handleTaskSignalToolCall(ctx, { state: 'done', summary: 'Done again' });

    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).toContain('No active task expects a lifecycle signal');
    expect(state.getTaskById).not.toHaveBeenCalled();
    expect(ctx.latestTaskSignal).toBeUndefined();
  });
});
