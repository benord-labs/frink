import { describe, expect, it } from 'vitest';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { flowRunId, flowSections, flowStatus, flowTrailing, matchingFlows } from './flow-list';

const NOW = Date.parse('2026-09-29T14:30:00Z');

function flow(overrides: Partial<MobileFlow> & Pick<MobileFlow, 'id'>): MobileFlow {
  return {
    name: overrides.id,
    description: '',
    enabled: true,
    trigger: 'manual_trigger',
    latestRunId: overrides.status ? `live-${overrides.id}` : null,
    status: null,
    lastRun: null,
    ...overrides,
  };
}
const lastRun = (status: string, minutes = 5) => ({
  id: `last-${status}-${minutes}`,
  status,
  at: new Date(NOW - minutes * 60_000).toISOString(),
});
const titles = (flows: MobileFlow[], query?: string) =>
  flowSections(flows, query).map((s) => [s.title, s.flows.map((f) => f.id)]);

describe('flowSections', () => {
  it('leads with what needs you, then what runs, what you paused and what just finished', () => {
    const flows = [
      flow({ id: 'live', status: 'running' }),
      flow({ id: 'failed', lastRun: lastRun('failed') }),
      flow({ id: 'waiting-off', enabled: false, status: 'awaiting_input' }),
      flow({ id: 'failed-off', enabled: false, lastRun: lastRun('failed', 6) }),
      flow({ id: 'parked', status: 'paused' }),
      flow({ id: 'done', lastRun: lastRun('completed') }),
      flow({ id: 'never' }),
    ];
    expect(titles(flows)).toEqual([
      ['Needs you', ['waiting-off']],
      ['Running', ['live']],
      ['Paused', ['parked']],
      ['Recent results', ['failed', 'done', 'failed-off']],
    ]);
  });

  // The Mac sends the live run's display status; the newest run keeps the engine's raw "paused".
  it('trusts the live display status over the raw paused run', () => {
    const waiting = flow({ id: 'w', status: 'awaiting_input', lastRun: lastRun('paused') });
    const working = flow({ id: 'r', status: 'running', lastRun: lastRun('paused') });
    expect(titles([waiting, working])).toEqual([
      ['Needs you', ['w']],
      ['Running', ['r']],
    ]);
  });

  it('sorts the latest result per flow, while the library still lists every Flow', () => {
    const results = [60, 5, 20, 1, 30, 90].map((minutes) =>
      flow({ id: `${minutes}`, lastRun: lastRun('completed', minutes) }),
    );
    expect(flowSections(results)[0].flows.map((f) => f.id)).toEqual([
      '1',
      '5',
      '20',
      '30',
      '60',
      '90',
    ]);
    expect(matchingFlows(results)).toHaveLength(6);
  });

  it('opens the live run while there is one, never an older finished run in its place', () => {
    const active = flow({ id: 'a', status: 'running', lastRun: lastRun('completed') });
    expect(flowRunId(active)).toBe('live-a');
    expect(flowRunId({ ...active, latestRunId: null })).toBeNull();
    expect(flowSections([{ ...active, latestRunId: null }])).toEqual([]);
    expect(flowRunId(flow({ id: 'b', lastRun: lastRun('completed', 7) }))).toBe('last-completed-7');
  });

  it('deduplicates run IDs across sections, keeping the most actionable row', () => {
    const rows = [
      flow({ id: 'old', lastRun: { ...lastRun('completed'), id: 'same' } }),
      flow({ id: 'wait', status: 'awaiting_input', latestRunId: 'same' }),
      flow({ id: 'copy', status: 'awaiting_input', latestRunId: 'same' }),
    ];
    expect(titles(rows)).toEqual([['Needs you', ['wait']]]);
  });

  it('filters by name or description', () => {
    const flows = [
      flow({ id: 'x', name: 'Digest', description: 'Support INBOX', status: 'running' }),
    ];
    expect(matchingFlows(flows, ' inbox ').map((f) => f.id)).toEqual(['x']);
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

  it('shows when a finished run ended, and names waits and failures', () => {
    expect(flowTrailing(flow({ id: 'a', lastRun: lastRun('completed', 90) }), NOW)).toEqual({
      text: '1h',
      tone: 'quiet',
    });
    expect(flowTrailing(flow({ id: 'a', status: 'awaiting_input' }), NOW)?.text).toBe(
      'Waiting for you',
    );
    expect(flowTrailing(flow({ id: 'a', lastRun: lastRun('failed') }), NOW)).toEqual({
      text: 'Failed',
      tone: 'danger',
    });
    expect(flowTrailing(flow({ id: 'a' }), NOW)).toBeNull();
  });
});
