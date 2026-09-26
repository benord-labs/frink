// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridCornerHandle } from './GridCornerHandle';

const CONTAINER_SIZE = 1000; // MIN_PANE_SIZE 200 => minRatio 0.2

function setup() {
  const onCommit = vi.fn();

  const container = document.createElement('div');
  container.getBoundingClientRect = () =>
    ({ width: CONTAINER_SIZE, height: CONTAINER_SIZE }) as DOMRect;
  const containerRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>;
  containerRef.current = container;

  const gridRatiosRef = createRef() as React.RefObject<{ rows: number[]; cols: number[] }>;
  gridRatiosRef.current = { rows: [0.5, 0.5], cols: [0.5, 0.5] };

  const { container: mount } = render(
    <GridCornerHandle
      corner="br"
      containerRef={containerRef}
      gridRatiosRef={gridRatiosRef}
      onCommit={onCommit}
    />,
  );

  const handle = mount.firstChild as HTMLElement;
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();

  return { handle, container, onCommit };
}

function pointerDown(handle: HTMLElement, init: MouseEventInit = {}) {
  handle.dispatchEvent(
    new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 500,
      clientY: 500,
      ...init,
    }),
  );
}

function pointerMoveTo(clientX: number, clientY: number) {
  document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY }));
}

const colRatio = (container: HTMLElement) => container.style.getPropertyValue('--grid-col-0');

afterEach(cleanup);

describe('GridCornerHandle drag', () => {
  it('ignores movement inside the dead zone on both axes', () => {
    const { handle, container } = setup();

    pointerDown(handle);
    pointerMoveTo(504, 504); // 0.004 on each axis, under the 0.005 threshold

    expect(colRatio(container)).toBe('');
  });

  // The dead zone clears when *either* axis moves far enough, not only when both do.
  it('starts tracking when a single axis crosses the dead zone', () => {
    const { handle, container } = setup();

    pointerDown(handle);
    pointerMoveTo(506, 500); // 0.006 horizontally, 0 vertically

    expect(colRatio(container)).not.toBe('');
  });

  it('snaps a ratio that lands near a grid fraction', () => {
    const { handle, container } = setup();

    pointerDown(handle);
    pointerMoveTo(665, 500); // 0.665 — within 0.04 of two-thirds

    expect(Number(colRatio(container))).toBeCloseTo(2 / 3, 5);
  });

  it('clamps to the minimum pane ratio when dragged past the edge', () => {
    const { handle, container } = setup();

    pointerDown(handle);
    pointerMoveTo(100, 500); // would be 0.1, below the 0.2 floor

    expect(Number(colRatio(container))).toBeCloseTo(0.2, 5);
  });

  it('commits both axes on pointerup', () => {
    const { handle, onCommit } = setup();

    pointerDown(handle);
    pointerMoveTo(665, 665);
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    expect(onCommit).toHaveBeenCalledOnce();
    const [rows, cols] = onCommit.mock.calls[0] as [number[], number[]];
    expect(rows[0]).toBeCloseTo(2 / 3, 5);
    expect(cols[0]).toBeCloseTo(2 / 3, 5);
    expect(rows[0] + rows[1]).toBeCloseTo(1, 5);
    expect(cols[0] + cols[1]).toBeCloseTo(1, 5);
  });

  it('ignores macOS Ctrl+click', () => {
    const { handle, container, onCommit } = setup();

    pointerDown(handle, { ctrlKey: true });
    pointerMoveTo(665, 665);
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    expect(colRatio(container)).toBe('');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
