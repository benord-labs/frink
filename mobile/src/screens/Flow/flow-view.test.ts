import { describe, expect, it } from 'vitest';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { currentRunId, enabledHint, flowAttention, runNowBlocker } from './flow-view';

describe('enabledHint', () => {
  it('names automatic triggers and manual Flows plainly', () => {
    expect(enabledHint({ enabled: true, trigger: 'schedule_trigger' })).toBe('Runs on a schedule');
    expect(enabledHint({ enabled: true, trigger: 'post_task_trigger' })).toBe(
      'Runs after a task finishes',
    );
    expect(enabledHint({ enabled: true, trigger: 'manual_trigger' })).toBe(
      'Runs when you start it',
    );
    expect(enabledHint({ enabled: false, trigger: 'webhook_trigger' })).toBe(
      'Off. Turn it on to run it.',
    );
  });
});

describe('runNowBlocker', () => {
  it('allows a run when the Mac is ready and the Flow is on', () => {
    expect(runNowBlocker({ enabled: true }, true)).toBeNull();
    expect(runNowBlocker({ enabled: true }, undefined)).toBeNull();
  });

  it('explains each blocker, the Mac first', () => {
    expect(runNowBlocker({ enabled: false }, false)).toBe('Open Frink on your Mac to run Flows.');
    expect(runNowBlocker({ enabled: false }, true)).toBe('Turn this Flow on to run it.');
  });
});

describe('flowAttention', () => {
  const now = new Date('2026-09-29T14:30:00Z');
  const flow: MobileFlow = {
    id: 'f',
    name: 'Release',
    description: '',
    enabled: true,
    trigger: 'manual_trigger',
    latestRunId: 'live',
    status: null,
    lastRun: null,
  };

  it('keeps the existing run as primary for human waits and user pauses', () => {
    expect(currentRunId({ ...flow, status: 'awaiting_input' })).toBe('live');
    expect(currentRunId({ ...flow, status: 'paused' })).toBe('live');
    expect(currentRunId({ ...flow, status: 'running' })).toBe('live');
    expect(currentRunId({ ...flow, status: 'completed' })).toBeNull();
    expect(currentRunId(flow)).toBeNull();
    expect(currentRunId({ ...flow, status: 'running', latestRunId: null })).toBeNull();
  });

  it('points a wait at the live run', () => {
    const waiting = {
      ...flow,
      status: 'awaiting_input',
      lastRun: { id: 'live', status: 'paused', at: now.toISOString() },
    };
    expect(flowAttention(waiting)).toMatchObject({
      title: 'Waiting for you',
      subtitle: 'Open the run to decide',
      runId: 'live',
    });
  });

  it('points a failure at the run that failed', () => {
    const failed = {
      ...flow,
      latestRunId: 'older',
      lastRun: { id: 'bad', status: 'failed', at: '2026-09-29T13:55:00Z' },
    };
    expect(flowAttention(failed)).toMatchObject({
      title: 'Last run failed',
      subtitle: 'Open the run to see what went wrong',
      runId: 'bad',
    });
  });

  it('stays quiet when nothing needs you', () => {
    expect(flowAttention({ ...flow, status: 'running' })).toBeNull();
    expect(
      flowAttention({ ...flow, lastRun: { id: 'ok', status: 'completed', at: now.toISOString() } }),
    ).toBeNull();
    expect(flowAttention(flow)).toBeNull();
  });
});
