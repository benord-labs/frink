import { describe, expect, it } from 'vitest';
import { groupFlowsIntoSections } from '.';

type Row = { id: string; is_enabled?: boolean; status: string | null };

const group = (rows: Row[]) =>
  groupFlowsIntoSections(rows, (row) => row.status).map((section) => ({
    id: section.id,
    ids: section.flows.map((row) => row.id),
  }));

describe('groupFlowsIntoSections', () => {
  it('surfaces only human waits and failures in Needs you, keeping input order', () => {
    expect(
      group([
        { id: 'a', status: 'completed' },
        { id: 'b', status: 'awaiting_input' },
        { id: 'c', status: 'paused' },
        { id: 'd', status: 'failed' },
        { id: 'e', status: 'running' },
      ]),
    ).toEqual([
      { id: 'needs_you', ids: ['b', 'd'] },
      { id: 'flows', ids: ['a', 'c', 'e'] },
    ]);
  });

  it('keeps a wait on the user in Needs you when the flow is off, but files an off flow failure under Disabled', () => {
    expect(
      group([
        { id: 'a', is_enabled: false, status: 'awaiting_input' },
        { id: 'b', is_enabled: false, status: 'failed' },
        { id: 'c', is_enabled: false, status: 'completed' },
        { id: 'd', status: 'failed' },
      ]),
    ).toEqual([
      { id: 'needs_you', ids: ['a', 'd'] },
      { id: 'disabled', ids: ['b', 'c'] },
    ]);
  });
});
