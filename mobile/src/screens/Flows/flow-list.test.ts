import { describe, expect, it } from 'vitest';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import {
  flowMenu,
  flowRunId,
  flowStatus,
  flowSubtitle,
  groupFlows,
  matchingFlows,
  needsYouLabel,
} from './flow-list';

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
const ids = (flows: MobileFlow[]) => flows.map((item) => item.id);
const nowIds = (flows: MobileFlow[]) => ids(groupFlows(flows).now.map((entry) => entry.flow));

describe('groupFlows', () => {
  it('puts every unfinished run in Now, waits included, and every Flow in All Flows', () => {
    // The computer reports a paused run as awaiting_input and a run waiting for Start as held.
    const flows = [
      flow({ id: 'live', status: 'running' }),
      flow({ id: 'failed', lastRun: lastRun('failed') }),
      flow({ id: 'waiting', status: 'awaiting_input', lastRun: lastRun('paused') }),
      flow({ id: 'held', status: 'held' }),
      flow({ id: 'queued', status: 'queued' }),
      flow({ id: 'done', lastRun: lastRun('completed') }),
      flow({ id: 'never', enabled: false }),
    ];
    expect(nowIds(flows)).toEqual(['live', 'waiting', 'held', 'queued']);
    expect(groupFlows(flows).now[0].runId).toBe('live-live');
    expect(ids(groupFlows(flows).all)).toEqual(ids(flows));
  });

  it('leaves out a live status without a run to open, and lists each run once', () => {
    const rows = [
      flow({ id: 'lost', status: 'running', latestRunId: null }),
      flow({ id: 'first', status: 'running', latestRunId: 'same' }),
      flow({ id: 'copy', status: 'running', latestRunId: 'same' }),
    ];
    expect(nowIds(rows)).toEqual(['first']);
  });
});

describe('needsYouLabel', () => {
  it('counts what needs you in one link, and hides at zero', () => {
    expect(needsYouLabel(0)).toBeNull();
    expect(needsYouLabel(1)).toBe('1 needs you');
    expect(needsYouLabel(4)).toBe('4 need you');
  });
});

describe('flow rows', () => {
  it('reports the live run over the last run, and opens the matching run', () => {
    const active = flow({ id: 'a', status: 'running', lastRun: lastRun('failed') });
    expect(flowStatus(active).word).toBe('Running');
    expect(flowRunId(active)).toBe('live-a');
    expect(flowRunId(flow({ id: 'b', lastRun: lastRun('completed', 7) }))).toBe('last-completed-7');
    expect(flowStatus(flow({ id: 'c' })).word).toBe('Never run');
  });

  it('describes a Flow, or says how it starts', () => {
    expect(flowSubtitle({ description: 'Triage issues', trigger: 'schedule_trigger' })).toBe(
      'Triage issues',
    );
    expect(flowSubtitle({ description: '', trigger: 'schedule_trigger' })).toBe(
      'Runs on a schedule',
    );
  });

  it('filters by name or description', () => {
    const flows = [flow({ id: 'x', name: 'Digest', description: 'Support INBOX' })];
    expect(ids(matchingFlows(flows, ' inbox '))).toEqual(['x']);
    expect(matchingFlows(flows, 'nothing')).toEqual([]);
  });
});

describe('flowMenu', () => {
  const labels = (item: MobileFlow) => flowMenu(item).map((entry) => entry.label);

  it('offers Run now only when the Flow is on and nothing is under way', () => {
    expect(labels(flow({ id: 'a', lastRun: lastRun('completed') }))).toEqual([
      'Run now',
      'Turn off',
      'View last run',
    ]);
    expect(labels(flow({ id: 'b', enabled: false }))).toEqual(['Turn on']);
    expect(labels(flow({ id: 'c', status: 'awaiting_input' }))).toEqual([
      'Turn off',
      'View current run',
    ]);
    expect(labels(flow({ id: 'd', status: 'running', latestRunId: null }))).toEqual(['Turn off']);
  });
});
