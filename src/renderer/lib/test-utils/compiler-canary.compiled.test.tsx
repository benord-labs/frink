// @vitest-environment happy-dom
/** The canary fixtures, run through the React Compiler as the shipped renderer is. The uncompiled
 * twin, compiler-canary.test.tsx, asserts the opposite counts for the same components. */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createRenderTally,
  type DragRowItem,
  InlineLiteralParent,
  InlineSensorList,
} from './compiler-canary';

const ROWS: DragRowItem[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
];

describe('renderer components under the React Compiler', () => {
  it('runs in the same sealed environment as every other test', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.FRINK_HOME).toContain('frink-test-home-');
    expect(process.env.ELECTRON_OVERRIDE_DIST_PATH).toMatch(/\.electron-test-sentinel$/);
  });

  it('compiles the components this project imports', () => {
    expect(InlineLiteralParent.toString()).toContain('react.memo_cache_sentinel');
  });

  it('keeps a memo child still when its parent re-renders with an inline object literal', () => {
    const tally = createRenderTally();
    const { rerender } = render(
      <InlineLiteralParent tick={0} label="one" onRender={tally.probe} />,
    );
    rerender(<InlineLiteralParent tick={1} label="one" onRender={tally.probe} />);
    rerender(<InlineLiteralParent tick={2} label="one" onRender={tally.probe} />);

    expect(tally.count('child')).toBe(1);
  });

  it('still re-renders that memo child when one of its props changes', () => {
    const tally = createRenderTally();
    const { rerender } = render(
      <InlineLiteralParent tick={0} label="one" onRender={tally.probe} />,
    );
    rerender(<InlineLiteralParent tick={1} label="two" onRender={tally.probe} />);

    expect(tally.count('child')).toBe(2);
  });

  it('keeps drag rows still when their list re-renders with inline sensor options', () => {
    const tally = createRenderTally();
    const { rerender } = render(<InlineSensorList tick={0} rows={ROWS} onRender={tally.probe} />);
    const mounted = { a: tally.count('a'), b: tally.count('b') };
    for (let tick = 1; tick <= 5; tick += 1) {
      rerender(<InlineSensorList tick={tick} rows={ROWS} onRender={tally.probe} />);
    }

    expect({ a: tally.count('a'), b: tally.count('b') }).toEqual(mounted);
  });

  it('still re-renders exactly the drag row whose label changes', () => {
    const tally = createRenderTally();
    const { rerender } = render(<InlineSensorList tick={0} rows={ROWS} onRender={tally.probe} />);
    const mounted = { a: tally.count('a'), b: tally.count('b') };
    const renamed = [ROWS[0], { id: 'b', label: 'Bravo' }];
    rerender(<InlineSensorList tick={1} rows={renamed} onRender={tally.probe} />);

    expect({ a: tally.count('a'), b: tally.count('b') }).toEqual({
      a: mounted.a,
      b: mounted.b + 1,
    });
  });
});
