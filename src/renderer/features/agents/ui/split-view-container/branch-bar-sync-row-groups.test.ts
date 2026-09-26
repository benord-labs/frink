import { describe, expect, it } from 'vitest';
import { getBranchBarSyncRowGroup, maxBranchBarHeightsInGroup } from './branch-bar-sync-row-groups';

describe('getBranchBarSyncRowGroup', () => {
  it('horizontal: single group for all panes', () => {
    expect(getBranchBarSyncRowGroup('horizontal', 0, 2)).toBe(0);
    expect(getBranchBarSyncRowGroup('horizontal', 1, 2)).toBe(0);
  });

  it('vertical: single group for all panes', () => {
    expect(getBranchBarSyncRowGroup('vertical', 0, 3)).toBe(0);
    expect(getBranchBarSyncRowGroup('vertical', 2, 3)).toBe(0);
  });

  it('grid with 4 panes: top row vs bottom row', () => {
    expect(getBranchBarSyncRowGroup('grid', 0, 4)).toBe(0);
    expect(getBranchBarSyncRowGroup('grid', 1, 4)).toBe(0);
    expect(getBranchBarSyncRowGroup('grid', 2, 4)).toBe(1);
    expect(getBranchBarSyncRowGroup('grid', 3, 4)).toBe(1);
  });

  it('three-bottom: top pair vs bottom full-width', () => {
    expect(getBranchBarSyncRowGroup('three-bottom', 0, 3)).toBe(0);
    expect(getBranchBarSyncRowGroup('three-bottom', 1, 3)).toBe(0);
    expect(getBranchBarSyncRowGroup('three-bottom', 2, 3)).toBe(1);
  });

  it('three-right: single group', () => {
    expect(getBranchBarSyncRowGroup('three-right', 0, 3)).toBe(0);
    expect(getBranchBarSyncRowGroup('three-right', 2, 3)).toBe(0);
  });
});

describe('maxBranchBarHeightsInGroup', () => {
  it('returns 0 for an empty heights map', () => {
    expect(maxBranchBarHeightsInGroup({}, 'horizontal', 2, 0)).toBe(0);
  });

  it('returns 0 when every reported height in the group is 0', () => {
    expect(maxBranchBarHeightsInGroup({ 0: 0, 1: 0 }, 'horizontal', 2, 0)).toBe(0);
    expect(maxBranchBarHeightsInGroup({ 0: 0, 1: 0 }, 'horizontal', 2, 1)).toBe(0);
  });

  it('grid isolates top row max from bottom row', () => {
    const heights = { 0: 40, 1: 48, 2: 20, 3: 22 };
    expect(maxBranchBarHeightsInGroup(heights, 'grid', 4, 0)).toBe(48);
    expect(maxBranchBarHeightsInGroup(heights, 'grid', 4, 1)).toBe(48);
    expect(maxBranchBarHeightsInGroup(heights, 'grid', 4, 2)).toBe(22);
    expect(maxBranchBarHeightsInGroup(heights, 'grid', 4, 3)).toBe(22);
  });

  it('three-bottom isolates top pair max from bottom pane', () => {
    const heights = { 0: 30, 1: 55, 2: 24 };
    expect(maxBranchBarHeightsInGroup(heights, 'three-bottom', 3, 0)).toBe(55);
    expect(maxBranchBarHeightsInGroup(heights, 'three-bottom', 3, 1)).toBe(55);
    expect(maxBranchBarHeightsInGroup(heights, 'three-bottom', 3, 2)).toBe(24);
  });

  it('grid with paneCount < 4 falls back to a single group (no 2×2 bands)', () => {
    const heights = { 0: 10, 1: 90 };
    expect(maxBranchBarHeightsInGroup(heights, 'grid', 3, 0)).toBe(90);
    expect(maxBranchBarHeightsInGroup(heights, 'grid', 3, 1)).toBe(90);
  });

  it('horizontal still uses global max across sparse indices', () => {
    const heights = { 0: 30, 2: 50 };
    expect(maxBranchBarHeightsInGroup(heights, 'horizontal', 3, 0)).toBe(50);
    expect(maxBranchBarHeightsInGroup(heights, 'horizontal', 3, 2)).toBe(50);
  });

  it('grid 2×2: sparse heights only in corners do not cross rows (EC9 grid)', () => {
    const heights = { 0: 32, 3: 64 };
    expect(maxBranchBarHeightsInGroup(heights, 'grid', 4, 0)).toBe(32);
    expect(maxBranchBarHeightsInGroup(heights, 'grid', 4, 3)).toBe(64);
  });
});
