import { describe, expect, it } from 'vitest';
import type { MobileFlow } from '../../../../src/shared/types/remote/mobile';
import { flowSections, flowStatus, flowTrailing } from './flow-list';

const NOW = Date.parse('2026-09-29T14:30:00Z');

function flow(overrides: Partial<MobileFlow> & Pick<MobileFlow, 'id'>): MobileFlow {
  return {
    name: overrides.id,
    description: '',
    enabled: true,
    trigger: 'manual_trigger',
    latestRunId: null,
    status: null,
    lastRun: null,
    ...overrides,
  };
}
const lastRun = (status: string, minutes = 5) => ({
  id: 'r',
  status,
  at: new Date(NOW - minutes * 60_000).toISOString(),
});

describe('flowSections', () => {
  const flows = [
    flow({ id: 'live', status: 'running' }),
    flow({ id: 'failed', lastRun: lastRun('failed') }),
    flow({ id: 'waiting-off', enabled: false, status: 'awaiting_input' }),
    flow({ id: 'failed-off', enabled: false, lastRun: lastRun('failed') }),
    flow({ id: 'idle' }),
  ];

  it('groups like the desktop list: waits and enabled failures need you', () => {
    expect(flowSections(flows).map((s) => [s.title, s.flows.map((f) => f.id)])).toEqual([
      ['Needs you', ['failed', 'waiting-off']],
      ['Enabled', ['live', 'idle']],
      ['Disabled', ['failed-off']],
    ]);
  });

  // The Mac sends the live run's display status; the newest run keeps the engine's raw "paused".
  it('trusts the live display status over the raw paused run', () => {
    const waiting = flow({ id: 'w', status: 'awaiting_input', lastRun: lastRun('paused') });
    const working = flow({ id: 'r', status: 'running', lastRun: lastRun('paused') });
    const parked = flow({ id: 'p', status: 'paused', lastRun: lastRun('paused') });
    expect(
      flowSections([waiting, working, parked]).map((s) => [s.title, s.flows.map((f) => f.id)]),
    ).toEqual([
      ['Needs you', ['w']],
      ['Enabled', ['r', 'p']],
    ]);
    expect(flowTrailing(waiting, NOW)).toEqual({ text: 'Waiting for you', tone: 'attention' });
    expect(flowTrailing(working, NOW)).toEqual({ text: 'Running', tone: 'live' });
    expect(flowTrailing(parked, NOW)).toEqual({ text: 'Paused', tone: 'quiet' });
  });

  it('filters by name or description and drops empty sections', () => {
    const described = [...flows, flow({ id: 'x', name: 'Digest', description: 'Support INBOX' })];
    expect(flowSections(described, ' inbox ').map((s) => s.flows.map((f) => f.id))).toEqual([
      ['x'],
    ]);
    expect(flowSections(flows, 'nothing')).toEqual([]);
  });
});

describe('flowTrailing', () => {
  it('prefers the live run over the last run', () => {
    expect(flowStatus(flow({ id: 'a', status: 'running', lastRun: lastRun('failed') })).word).toBe(
      'Running',
    );
    expect(flowTrailing(flow({ id: 'a', status: 'running' }), NOW)).toEqual({
      text: 'Running',
      tone: 'live',
    });
  });

  it('shows when it last ran for a finished run, and nothing for a new Flow', () => {
    expect(flowTrailing(flow({ id: 'a', lastRun: lastRun('completed', 90) }), NOW)).toEqual({
      text: '1h',
      tone: 'quiet',
    });
    expect(flowTrailing(flow({ id: 'a' }), NOW)).toBeNull();
  });

  it('says Off for a disabled Flow unless something is waiting', () => {
    expect(
      flowTrailing(flow({ id: 'a', enabled: false, lastRun: lastRun('failed') }), NOW),
    ).toEqual({
      text: 'Off',
      tone: 'quiet',
    });
    expect(
      flowTrailing(flow({ id: 'a', enabled: false, status: 'awaiting_input' }), NOW)?.text,
    ).toBe('Waiting for you');
  });

  it('names an enabled failure in red', () => {
    expect(flowTrailing(flow({ id: 'a', lastRun: lastRun('failed') }), NOW)).toEqual({
      text: 'Failed',
      tone: 'danger',
    });
  });
});
