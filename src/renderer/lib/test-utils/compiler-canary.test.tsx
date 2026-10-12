// @vitest-environment happy-dom
/** The canary fixtures uncompiled, as every test outside the compiled project runs. The compiled
 * twin asserts the opposite counts, which are the ones the shipped renderer has. */
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

describe('renderer components without the React Compiler', () => {
  it('leaves the components this project imports uncompiled', () => {
    expect(InlineLiteralParent.toString()).not.toContain('react.memo_cache_sentinel');
  });

  it('re-renders a memo child on every parent render that passes an inline object literal', () => {
    const tally = createRenderTally();
    const { rerender } = render(
      <InlineLiteralParent tick={0} label="one" onRender={tally.probe} />,
    );
    rerender(<InlineLiteralParent tick={1} label="one" onRender={tally.probe} />);
    rerender(<InlineLiteralParent tick={2} label="one" onRender={tally.probe} />);

    expect(tally.count('child')).toBe(3);
  });

  it('re-renders every drag row when their list re-renders with inline sensor options', () => {
    const tally = createRenderTally();
    const { rerender } = render(<InlineSensorList tick={0} rows={ROWS} onRender={tally.probe} />);
    const mounted = { a: tally.count('a'), b: tally.count('b') };
    for (let tick = 1; tick <= 5; tick += 1) {
      rerender(<InlineSensorList tick={tick} rows={ROWS} onRender={tally.probe} />);
    }

    expect(tally.count('a')).toBeGreaterThan(mounted.a);
    expect(tally.count('b')).toBeGreaterThan(mounted.b);
  });
});
