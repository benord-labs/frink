import { describe, expect, it } from 'vitest';
import { resolveAutoCompletionAction } from './task-completion-policy';

describe('task completion policy', () => {
  it('resolves auto action only while running', () => {
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: { startMode: 'plan', skipReview: false },
      }),
    ).toBe('mark_plan_ready');
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: { startMode: 'plan', skipReview: true },
      }),
    ).toBe('complete');
    expect(resolveAutoCompletionAction({ status: 'plan_ready', result: {} })).toBeNull();
  });

  it('stands down when no signal and no marker are present', () => {
    // The chat's streaming flag tracks presentation liveness and can flip mid-turn; the main
    // process owns parking on silence (quiet-end marker → flows sweep), so nothing is written here.
    expect(resolveAutoCompletionAction({ status: 'running', result: {} })).toBeNull();
    expect(resolveAutoCompletionAction({ status: 'running' })).toBeNull();
    expect(
      resolveAutoCompletionAction({ status: 'running', result: { startMode: 'execute' } }),
    ).toBeNull();
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: { skipReview: true },
        triggerContext: { _config: { completionSignal: 'manual' } } as never,
      }),
    ).toBeNull();
  });

  it('defers to the quiet-idle sweep when a quiet-end marker is present and no signal arrived', () => {
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: { quietEndedAt: '2026-07-20T00:00:00.000Z' },
      }),
    ).toBeNull();
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: { startMode: 'execute', quietEndedAt: '2026-07-20T00:00:00.000Z' },
      }),
    ).toBeNull();
    // An explicit signal always wins over the marker.
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          quietEndedAt: '2026-07-20T00:00:00.000Z',
          agentSignal: { state: 'done' },
        },
      }),
    ).toBe('mark_done');
    // Plan tasks defer too: a quiet end during DRAFTING is an agent still waiting on background
    // work (e.g. a wake hold on research subagents) — marking plan_ready there stamps a review
    // state with no plan to review. A real submission never carries the marker: the main process
    // suppresses the quiet-end write on the plan-halt path.
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'plan',
          skipReview: false,
          quietEndedAt: '2026-07-20T00:00:00.000Z',
        },
      }),
    ).toBeNull();
    // A plan task with a done signal keeps its review path even when a stale marker remains.
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'plan',
          skipReview: false,
          quietEndedAt: '2026-07-20T00:00:00.000Z',
          agentSignal: { state: 'done' },
        },
      }),
    ).toBe('mark_plan_ready');
  });

  it('uses triggerContext startMode fallback when result startMode is missing', () => {
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: { skipReview: false },
        triggerContext: { _config: { startMode: 'plan' } } as never,
      }),
    ).toBe('mark_plan_ready');
  });

  it('prioritizes explicit agent signal metadata when available', () => {
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'execute',
          agentSignal: { state: 'done' },
        },
      }),
    ).toBe('mark_done');
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'execute',
          agentSignal: { state: 'failed' },
        },
      }),
    ).toBe('failed');
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'execute',
          agentSignal: { state: 'blocked' },
        },
      }),
    ).toBe('needs_attention');
  });

  it('resolves done signal correctly for plan mode review paths', () => {
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'plan',
          skipReview: false,
          agentSignal: { state: 'done' },
        },
      }),
    ).toBe('mark_plan_ready');
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'plan',
          skipReview: true,
          agentSignal: { state: 'done' },
        },
      }),
    ).toBe('complete');
  });

  it('supports sequential signal progression by always using latest state', () => {
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'execute',
          agentSignal: { state: 'awaiting_input' },
        },
      }),
    ).toBe('needs_attention');
    expect(
      resolveAutoCompletionAction({
        status: 'running',
        result: {
          startMode: 'execute',
          agentSignal: { state: 'done' },
        },
      }),
    ).toBe('mark_done');
  });
});
