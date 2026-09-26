// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  getDefaultLayout,
  getDefaultRatios,
  getLayoutCycleDescription,
  getNextLayout,
  getValidLayouts,
  normalizeSplitViewState,
} from './index';

describe('getValidLayouts', () => {
  it('returns grid, horizontal, and vertical for four panes', () => {
    expect(getValidLayouts(4)).toEqual(['grid', 'horizontal', 'vertical']);
  });

  it('returns 2x1 grid layouts plus uniform linear for three panes', () => {
    expect(getValidLayouts(3)).toEqual(['three-bottom', 'three-right', 'horizontal', 'vertical']);
  });

  it('returns horizontal and vertical for two panes', () => {
    expect(getValidLayouts(2)).toEqual(['horizontal', 'vertical']);
  });

  it('returns empty array for zero or one pane (no layout cycle)', () => {
    expect(getValidLayouts(0)).toEqual([]);
    expect(getValidLayouts(1)).toEqual([]);
  });
});

describe('getNextLayout', () => {
  it('cycles grid → horizontal → vertical → grid for four panes', () => {
    expect(getNextLayout('grid', 4)).toBe('horizontal');
    expect(getNextLayout('horizontal', 4)).toBe('vertical');
    expect(getNextLayout('vertical', 4)).toBe('grid');
  });

  it('cycles three-pane layouts in order', () => {
    expect(getNextLayout('three-bottom', 3)).toBe('three-right');
    expect(getNextLayout('three-right', 3)).toBe('horizontal');
    expect(getNextLayout('horizontal', 3)).toBe('vertical');
    expect(getNextLayout('vertical', 3)).toBe('three-bottom');
  });

  it('cycles two-pane vertical to horizontal', () => {
    expect(getNextLayout('vertical', 2)).toBe('horizontal');
  });

  it('when layout is invalid for pane count, next is the first valid layout', () => {
    expect(getNextLayout('grid', 3)).toBe(getDefaultLayout(3));
    expect(getNextLayout('three-bottom', 4)).toBe(getDefaultLayout(4));
  });
});

describe('getLayoutCycleDescription', () => {
  it('describes four-pane destinations', () => {
    expect(getLayoutCycleDescription('horizontal', 4)).toContain('four');
    expect(getLayoutCycleDescription('vertical', 4)).toContain('four');
    expect(getLayoutCycleDescription('grid', 4)).toContain('2×2');
  });

  it('describes three-pane destinations', () => {
    expect(getLayoutCycleDescription('three-bottom', 3)).toContain('2×1');
    expect(getLayoutCycleDescription('horizontal', 3)).toContain('three');
    expect(getLayoutCycleDescription('vertical', 3)).toContain('three');
  });
});

describe('normalizeSplitViewState', () => {
  it('preserves valid four-pane horizontal layout', () => {
    const base = {
      chatIds: ['a', 'b', 'c', 'd'] as (string | null)[],
      ratios: getDefaultRatios(4),
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    };
    const out = normalizeSplitViewState(base);
    expect(out.layout).toBe('horizontal');
  });

  it('preserves valid four-pane vertical layout', () => {
    const base = {
      chatIds: ['a', 'b', 'c', 'd'] as (string | null)[],
      ratios: getDefaultRatios(4),
      activePaneIndex: 1,
      layout: 'vertical' as const,
    };
    const out = normalizeSplitViewState(base);
    expect(out.layout).toBe('vertical');
  });

  it('preserves valid three-bottom layout', () => {
    const base = {
      chatIds: ['a', 'b', 'c'] as (string | null)[],
      ratios: getDefaultRatios(3),
      activePaneIndex: 0,
      layout: 'three-bottom' as const,
    };
    const out = normalizeSplitViewState(base);
    expect(out.layout).toBe('three-bottom');
  });

  it('remaps layout when stored pane count does not allow that layout (hydration / bad state)', () => {
    expect(
      normalizeSplitViewState({
        chatIds: ['a', 'b', 'c'],
        ratios: getDefaultRatios(3),
        activePaneIndex: 0,
        layout: 'grid',
      }).layout,
    ).toBe(getDefaultLayout(3));

    expect(
      normalizeSplitViewState({
        chatIds: ['a', 'b'],
        ratios: getDefaultRatios(2),
        activePaneIndex: 0,
        layout: 'three-bottom',
      }).layout,
    ).toBe(getDefaultLayout(2));

    expect(
      normalizeSplitViewState({
        chatIds: ['a', 'b'],
        ratios: getDefaultRatios(2),
        activePaneIndex: 0,
        layout: 'three-right',
      }).layout,
    ).toBe(getDefaultLayout(2));

    expect(
      normalizeSplitViewState({
        chatIds: ['a', 'b', 'c', 'd'],
        ratios: getDefaultRatios(4),
        activePaneIndex: 0,
        layout: 'three-bottom',
      }).layout,
    ).toBe(getDefaultLayout(4));
  });
});
