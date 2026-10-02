// @vitest-environment happy-dom
// grid-helpers imports the split atoms, which read window storage at load.

import { describe, expect, it } from 'vitest';
import { getGridPaneOuterCorners, getLinearPaneOuterCorners } from './grid-helpers';

const rounded = (c: Record<string, boolean>) =>
  Object.entries(c)
    .filter(([, on]) => on)
    .map(([corner]) => corner)
    .sort();

describe('pane outer corners', () => {
  it('rounds every corner of a lone pane', () => {
    expect(rounded(getLinearPaneOuterCorners(false, 0, 1))).toEqual(['bl', 'br', 'tl', 'tr']);
    expect(rounded(getGridPaneOuterCorners('grid', 0, 1))).toEqual(['bl', 'br', 'tl', 'tr']);
  });

  it('rounds only the outer ends of a row or column', () => {
    expect(rounded(getLinearPaneOuterCorners(false, 0, 4))).toEqual(['bl', 'tl']);
    expect(rounded(getLinearPaneOuterCorners(false, 1, 4))).toEqual([]);
    expect(rounded(getLinearPaneOuterCorners(false, 3, 4))).toEqual(['br', 'tr']);
    expect(rounded(getLinearPaneOuterCorners(true, 0, 2))).toEqual(['tl', 'tr']);
    expect(rounded(getLinearPaneOuterCorners(true, 1, 2))).toEqual(['bl', 'br']);
  });

  it('rounds one outer corner per 2x2 grid pane and a full outer edge for the wide three-pane pane', () => {
    expect([0, 1, 2, 3].map((i) => rounded(getGridPaneOuterCorners('grid', i, 4)))).toEqual([
      ['tl'],
      ['tr'],
      ['bl'],
      ['br'],
    ]);
    expect(rounded(getGridPaneOuterCorners('three-bottom', 2, 3))).toEqual(['bl', 'br']);
    expect(rounded(getGridPaneOuterCorners('three-right', 2, 3))).toEqual(['br', 'tr']);
  });
});
