import { describe, expect, it } from 'vitest';
import {
  growLinearMultiPaneRatios,
  LINEAR_MULTI_MIN_RATIO,
  LINEAR_MULTI_RESIZE_STEP,
  shrinkLinearMultiPaneRatios,
} from './linear-multi-pane-resize';

const equalN = (n: number): number[] => Array(n).fill(1 / n);

describe('growLinearMultiPaneRatios', () => {
  it('adjusts four panes (same as former four-vertical behavior)', () => {
    const r = equalN(4);
    const next = growLinearMultiPaneRatios(r, 1, 4);
    expect(next[1]).toBeGreaterThan(r[1] ?? 0);
    expect(next[2]).toBeLessThan(r[2] ?? 0);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('works for three panes', () => {
    const r = equalN(3);
    const next = growLinearMultiPaneRatios(r, 0, 3);
    expect(next[0]).toBeGreaterThan(r[0] ?? 0);
    expect(next[1]).toBeLessThan(r[1] ?? 0);
  });

  it('grows last pane by taking from previous (active === n - 1)', () => {
    const r = equalN(4);
    const next = growLinearMultiPaneRatios(r, 3, 4);
    expect(next[3]).toBeGreaterThan(r[3] ?? 0);
    expect(next[2]).toBeLessThan(r[2] ?? 0);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('adjusts two-pane split when growing first pane', () => {
    const r = equalN(2);
    const next = growLinearMultiPaneRatios(r, 0, 2);
    expect(next[0]).toBeGreaterThan(r[0] ?? 0);
    expect(next[1]).toBeLessThan(r[1] ?? 0);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('no-ops when n < 2 (returns copy with same values)', () => {
    const r = [0.4, 0.3, 0.3];
    expect(growLinearMultiPaneRatios(r, 0, 1)).toEqual(r);
  });

  it('no-ops when ratios length does not match n', () => {
    const r = [0.5, 0.5];
    expect(growLinearMultiPaneRatios(r, 0, 4)).toEqual(r);
  });

  it('preserves sum and min ratio after many grow steps from equal split', () => {
    let r = equalN(4);
    for (let step = 0; step < 48; step++) {
      r = growLinearMultiPaneRatios(r, step % 4, 4);
    }
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    for (const v of r) {
      expect(v).toBeGreaterThanOrEqual(LINEAR_MULTI_MIN_RATIO - 1e-6);
    }
  });
});

describe('shrinkLinearMultiPaneRatios', () => {
  it('shrinks active pane for four panes', () => {
    const r = equalN(4);
    const next = shrinkLinearMultiPaneRatios(r, 0, 4);
    expect(next[0]).toBeLessThan(r[0] ?? 0);
    expect(next[0]).toBeGreaterThanOrEqual(LINEAR_MULTI_MIN_RATIO - 1e-6);
  });

  it('preserves total sum ~= 1', () => {
    const r = equalN(4);
    const next = shrinkLinearMultiPaneRatios(r, 0, 4);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('three panes: shrinks first pane; neighbor adjusts; respects LINEAR_MULTI_MIN_RATIO', () => {
    const r = equalN(3);
    const next = shrinkLinearMultiPaneRatios(r, 0, 3);
    expect(next[0]).toBeLessThan(r[0] ?? 0);
    expect(next[1]).toBeGreaterThan(r[1] ?? 0);
    expect(next[2]).toBeCloseTo(r[2] ?? 0, 5);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    for (const v of next) {
      expect(v).toBeGreaterThanOrEqual(LINEAR_MULTI_MIN_RATIO - 1e-6);
    }
  });

  it('three panes: shrinks last pane; previous neighbor adjusts; respects LINEAR_MULTI_MIN_RATIO', () => {
    const r = equalN(3);
    const next = shrinkLinearMultiPaneRatios(r, 2, 3);
    expect(next[2]).toBeLessThan(r[2] ?? 0);
    expect(next[1]).toBeGreaterThan(r[1] ?? 0);
    expect(next[0]).toBeCloseTo(r[0] ?? 0, 5);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    for (const v of next) {
      expect(v).toBeGreaterThanOrEqual(LINEAR_MULTI_MIN_RATIO - 1e-6);
    }
  });

  it('does not shrink active pane below LINEAR_MULTI_MIN_RATIO when already at floor', () => {
    const min = LINEAR_MULTI_MIN_RATIO;
    const r = [min, 1 - min];
    const next = shrinkLinearMultiPaneRatios(r, 0, 2);
    expect(next[0]).toBeCloseTo(min, 5);
    expect(next[1]).toBeCloseTo(1 - min, 5);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('no-ops when n < 2 (returns copy with same values)', () => {
    const r = [0.6, 0.4];
    expect(shrinkLinearMultiPaneRatios(r, 0, 1)).toEqual(r);
  });

  it('no-ops when ratios length does not match n', () => {
    const r = [0.25, 0.25, 0.25, 0.25];
    expect(shrinkLinearMultiPaneRatios(r, 0, 3)).toEqual(r);
  });

  it('preserves sum after many shrink steps from equal split', () => {
    let r = equalN(4);
    for (let step = 0; step < 48; step++) {
      r = shrinkLinearMultiPaneRatios(r, step % 4, 4);
    }
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    for (const v of r) {
      expect(v).toBeGreaterThanOrEqual(LINEAR_MULTI_MIN_RATIO - 1e-6);
    }
  });

  it('clamps shrink when pair leaves no room below step (adjacent at minimum)', () => {
    const min = LINEAR_MULTI_MIN_RATIO;
    const r = [min + LINEAR_MULTI_RESIZE_STEP / 2, 1 - min - LINEAR_MULTI_RESIZE_STEP / 2];
    const next = shrinkLinearMultiPaneRatios(r, 0, 2);
    expect(next[0]).toBeGreaterThanOrEqual(min - 1e-9);
    expect(next[1]).toBeGreaterThanOrEqual(min - 1e-9);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });
});
