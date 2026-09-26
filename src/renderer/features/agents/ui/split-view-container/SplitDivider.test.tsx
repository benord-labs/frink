// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplitDivider } from './SplitDivider';

// Radix's context menu needs a portal/provider stack that is irrelevant to drag behaviour.
vi.mock('../../../../components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
}));

const CONTAINER_SIZE = 1000;

function setup(ratios = [0.5, 0.5]) {
  const onCommitRatios = vi.fn();
  const onCloseSplit = vi.fn();

  const container = document.createElement('div');
  container.getBoundingClientRect = () =>
    ({ width: CONTAINER_SIZE, height: CONTAINER_SIZE }) as DOMRect;
  const containerRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>;
  containerRef.current = container;

  const ratiosRef = createRef<number[]>() as React.RefObject<number[]>;
  ratiosRef.current = ratios;

  render(
    <SplitDivider
      index={0}
      isVertical={false}
      containerRef={containerRef}
      ratiosRef={ratiosRef}
      onCommitRatios={onCommitRatios}
      onCloseSplit={onCloseSplit}
    />,
  );

  const handle = screen.getByRole('separator');
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();

  return { handle, container, onCommitRatios, onCloseSplit };
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

function pointerMoveTo(clientX: number) {
  document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY: 500 }));
}

function pointerUp() {
  document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
}

afterEach(cleanup);

describe('SplitDivider click-vs-drag discrimination', () => {
  it('closes the split when released without crossing the 3px drag threshold', () => {
    const { handle, onCommitRatios, onCloseSplit } = setup();

    pointerDown(handle);
    pointerMoveTo(502); // 2px — inside the dead zone
    pointerUp();

    expect(onCloseSplit).toHaveBeenCalledOnce();
    expect(onCommitRatios).not.toHaveBeenCalled();
  });

  it('commits resized ratios when the drag crosses the threshold', () => {
    const { handle, onCommitRatios, onCloseSplit } = setup();

    pointerDown(handle);
    pointerMoveTo(600); // +100px of a 1000px container => +0.1
    pointerUp();

    expect(onCloseSplit).not.toHaveBeenCalled();
    expect(onCommitRatios).toHaveBeenCalledOnce();
    const [committed] = onCommitRatios.mock.calls[0] as [number[]];
    expect(committed[0]).toBeCloseTo(0.6, 5);
    expect(committed[1]).toBeCloseTo(0.4, 5);
  });

  it('commits rather than closing when the pointer is cancelled mid-drag', () => {
    const { handle, onCommitRatios, onCloseSplit } = setup();

    pointerDown(handle);
    pointerMoveTo(600);
    document.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));

    expect(onCommitRatios).toHaveBeenCalledOnce();
    expect(onCloseSplit).not.toHaveBeenCalled();
  });

  it('ignores secondary-button presses so the context menu is not hijacked', () => {
    const { handle, onCommitRatios, onCloseSplit } = setup();

    pointerDown(handle, { button: 2 });
    pointerMoveTo(600);
    pointerUp();

    expect(onCommitRatios).not.toHaveBeenCalled();
    expect(onCloseSplit).not.toHaveBeenCalled();
  });

  // On macOS, Ctrl+click is the standard secondary click: it dispatches pointerdown with
  // button === 0 and ctrlKey === true, then a contextmenu event. Treating it as a primary click
  // makes the no-movement branch destroy the split the user was trying to open a menu on.
  it('ignores macOS Ctrl+click so it cannot silently close the split', () => {
    const { handle, onCommitRatios, onCloseSplit } = setup();

    pointerDown(handle, { button: 0, ctrlKey: true });
    pointerUp();

    expect(onCloseSplit).not.toHaveBeenCalled();
    expect(onCommitRatios).not.toHaveBeenCalled();
  });
});

describe('SplitDivider keyboard operation', () => {
  // Keyboard steps must not be snapped: the grid radius is wider than one step, so a snapped
  // step starting from a grid value lands back on it and the divider becomes immovable.
  it('moves off an exact grid ratio on the first arrow press', async () => {
    const { handle, onCommitRatios } = setup([0.5, 0.5]);
    handle.focus();

    await userEvent.keyboard('{ArrowRight}');

    const [committed] = onCommitRatios.mock.calls[0] as [number[]];
    expect(committed[0]).toBeCloseTo(0.52, 5);
    expect(committed[1]).toBeCloseTo(0.48, 5);
  });

  it('accumulates repeated arrow presses instead of stalling', async () => {
    const ratios = [0.5, 0.5];
    const { handle, onCommitRatios } = setup(ratios);
    handle.focus();

    // ratiosRef is the live source each keypress reads from, as it is in the real container.
    for (let i = 0; i < 3; i++) {
      await userEvent.keyboard('{ArrowRight}');
      const [next] = onCommitRatios.mock.calls[i] as [number[]];
      ratios[0] = next[0];
      ratios[1] = next[1];
    }

    expect(ratios[0]).toBeCloseTo(0.56, 5);
  });

  it('closes the split on Enter', async () => {
    const { handle, onCloseSplit } = setup();
    handle.focus();

    await userEvent.keyboard('{Enter}');

    expect(onCloseSplit).toHaveBeenCalledOnce();
  });
});
