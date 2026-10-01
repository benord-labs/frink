import { describe, expect, it } from 'vitest';
import { flowRunDisplayStatus } from './run-display-status';

describe('flowRunDisplayStatus', () => {
  it('relabels a paused run to running when an agent task is live', () => {
    expect(flowRunDisplayStatus('paused', 'running')).toBe('running');
    expect(flowRunDisplayStatus('paused', 'pending')).toBe('running');
  });

  it('relabels a paused run to awaiting_input when parked for user action', () => {
    expect(flowRunDisplayStatus('paused', 'plan_ready')).toBe('awaiting_input');
    expect(flowRunDisplayStatus('paused', 'needs_attention')).toBe('awaiting_input');
  });

  it('passes through when not paused, or paused with no active task', () => {
    expect(flowRunDisplayStatus('paused', null)).toBe('paused');
    expect(flowRunDisplayStatus('paused', undefined)).toBe('paused');
    expect(flowRunDisplayStatus('running', 'running')).toBe('running');
    expect(flowRunDisplayStatus('completed', 'running')).toBe('completed');
  });

  it('prioritizes a queued admission without changing the existing two-argument behavior', () => {
    expect(flowRunDisplayStatus('pending', null, 'queued')).toBe('queued');
    expect(flowRunDisplayStatus('paused', 'running', 'queued')).toBe('queued');
    expect(flowRunDisplayStatus('paused', 'running')).toBe('running');
  });
});
