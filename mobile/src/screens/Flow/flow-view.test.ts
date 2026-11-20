import { describe, expect, it } from 'vitest';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { currentRunId, runNowBlocker, saveEnabled, triggerWords } from './flow-view';

describe('triggerWords', () => {
  it('names automatic triggers and manual Flows plainly', () => {
    expect(triggerWords('schedule_trigger')).toBe('Runs on a schedule');
    expect(triggerWords('post_task_trigger')).toBe('Runs after a task finishes');
    expect(triggerWords('manual_trigger')).toBe('Runs when you start it');
  });
});

describe('runNowBlocker', () => {
  it('allows a run when the Mac is ready and the Flow is on', () => {
    expect(runNowBlocker({ enabled: true, status: null }, true)).toBeNull();
    expect(runNowBlocker({ enabled: true, status: 'failed' }, undefined)).toBeNull();
  });

  it('explains each blocker, an unfinished run first', () => {
    expect(runNowBlocker({ enabled: true, status: 'held' }, false)).toBe(
      'Refresh to find the current run.',
    );
    expect(runNowBlocker({ enabled: false, status: 'completed' }, false)).toBe(
      'Open Frink on your Mac to run Flows.',
    );
    expect(runNowBlocker({ enabled: false, status: null }, true)).toBe(
      'Turn this Flow on to run it.',
    );
  });
});

describe('currentRunId', () => {
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
});

describe('saveEnabled', () => {
  async function save(accepted: boolean) {
    const shown: Array<boolean | null> = [];
    let saved = 0;
    await saveEnabled(false, {
      show: (value) => shown.push(value),
      send: async () => accepted,
      saved: () => saved++,
    });
    return { shown, saved };
  }

  it('holds the new position once the computer accepts it', async () => {
    expect(await save(true)).toEqual({ shown: [false], saved: 1 });
  });

  it('moves the switch back when the computer refuses', async () => {
    expect(await save(false)).toEqual({ shown: [false, null], saved: 0 });
  });
});
