// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { SplitViewState } from '../atoms';
import { adjustActivePaneSplitRatios } from './split-view-active-pane-resize';

function twoPaneState(overrides: Partial<SplitViewState>): SplitViewState {
  return {
    chatIds: ['a', 'b'],
    ratios: [0.5, 0.5],
    activePaneIndex: 0,
    layout: 'horizontal',
    ...overrides,
  };
}

describe('adjustActivePaneSplitRatios', () => {
  it('clamps NaN activePaneIndex to 0 for 2-pane resize and normalizes state', () => {
    const prev = twoPaneState({ activePaneIndex: Number.NaN });
    const out = adjustActivePaneSplitRatios(prev, 'grow');
    expect(out.activePaneIndex).toBe(0);
    expect(out.ratios[0]).toBeGreaterThan(0.5);
    const r0 = out.ratios[0] ?? 0;
    const r1 = out.ratios[1] ?? 0;
    expect(r0 + r1).toBeCloseTo(1, 5);
  });

  it('clamps out-of-range activePaneIndex to n-1 for 2-pane resize', () => {
    const prev = twoPaneState({ activePaneIndex: 99 });
    const out = adjustActivePaneSplitRatios(prev, 'grow');
    expect(out.activePaneIndex).toBe(1);
    expect(out.ratios[1]).toBeGreaterThan(0.5);
    const r0 = out.ratios[0] ?? 0;
    const r1 = out.ratios[1] ?? 0;
    expect(r0 + r1).toBeCloseTo(1, 5);
  });

  it('clamps negative activePaneIndex to 0 for 2-pane resize', () => {
    const prev = twoPaneState({ activePaneIndex: -5 });
    const out = adjustActivePaneSplitRatios(prev, 'grow');
    expect(out.activePaneIndex).toBe(0);
    expect(out.ratios[0]).toBeGreaterThan(0.5);
  });

  it('truncates fractional activePaneIndex before clamping (2-pane)', () => {
    const prev = twoPaneState({ activePaneIndex: 0.9 });
    const out = adjustActivePaneSplitRatios(prev, 'grow');
    expect(out.activePaneIndex).toBe(0);
  });

  it('normalizes activePaneIndex only when no layout branch applies (corrupt state)', () => {
    const prev: SplitViewState = {
      chatIds: ['a', 'b', 'c'],
      ratios: [1 / 3, 1 / 3, 1 / 3],
      activePaneIndex: Number.NaN,
      layout: 'grid',
    };
    const out = adjustActivePaneSplitRatios(prev, 'grow');
    expect(out.activePaneIndex).toBe(0);
    expect(out.ratios).toEqual(prev.ratios);
    expect(out.layout).toBe('grid');
  });
});
