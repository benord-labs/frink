import { describe, expect, it } from 'vitest';
import { flowRunState, formatFlowUpdated } from '.';

const saved = { node_count: 3 };

describe('flowRunState', () => {
  it('names drafts and never-run flows before reading the run status', () => {
    expect(flowRunState({ node_count: null }, 'failed').word).toBe('Draft');
    expect(flowRunState(saved, null).word).toBe('Never run');
  });

  it('spends colour only on states the user can act on', () => {
    expect(flowRunState(saved, 'awaiting_input').tone).toBe('warn');
    expect(flowRunState(saved, 'failed')).toMatchObject({ tone: 'fail', word: 'Failed' });
    expect(flowRunState(saved, 'running').tone).toBe('live');
    expect(flowRunState(saved, 'paused').tone).toBe('quiet');
    expect(flowRunState(saved, 'completed').tone).toBe('quiet');
    expect(flowRunState(saved, 'completed').word).toBeUndefined();
  });

  it('describes a queued run by position and wait, omitting what is unknown', () => {
    expect(flowRunState({ ...saved, latest_run_queue_position: 3 }, 'queued').word).toBe(
      'Queued · #3',
    );
    expect(flowRunState(saved, 'queued').word).toBe('Queued');
  });

  it('never shows a raw status key for an unmapped status', () => {
    const unknown = flowRunState(saved, 'timed_out');
    expect(unknown.label).toBe('Unknown status');
    expect(unknown.word).toBeUndefined();
  });
});

describe('formatFlowUpdated', () => {
  it('stays relative inside a week', () => {
    expect(formatFlowUpdated(new Date(Date.now() - 60 * 60 * 1000).toISOString())).toMatch(/ago/);
  });

  it('shows a date after a week, with the year when it is not this year', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(formatFlowUpdated(new Date(Date.now() - 8 * day).toISOString())).not.toMatch(/ago/);
    const old = new Date(Date.now() - 400 * day);
    expect(formatFlowUpdated(old.toISOString())).toContain(String(old.getFullYear()));
  });
});
