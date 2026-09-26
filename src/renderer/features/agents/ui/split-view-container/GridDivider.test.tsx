// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridDivider } from './GridDivider';

vi.mock('../../../../components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
}));

const CONTAINER_SIZE = 1000;

function setup(orientation: 'horizontal' | 'vertical') {
  const onCommit = vi.fn();
  const onResetToEqual = vi.fn();

  const container = document.createElement('div');
  container.getBoundingClientRect = () =>
    ({ width: CONTAINER_SIZE, height: CONTAINER_SIZE }) as DOMRect;
  const containerRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>;
  containerRef.current = container;

  const gridRatiosRef = createRef() as React.RefObject<{ rows: number[]; cols: number[] }>;
  gridRatiosRef.current = { rows: [0.5, 0.5], cols: [0.5, 0.5] };

  render(
    <GridDivider
      orientation={orientation}
      containerRef={containerRef}
      gridRatiosRef={gridRatiosRef}
      onCommit={onCommit}
      onResetToEqual={onResetToEqual}
      placement={{ gridColumn: '1', gridRow: '1' }}
    />,
  );

  const handle = screen.getByRole('separator');
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();

  return { handle, container, onCommit, onResetToEqual };
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

function pointerUp() {
  document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
}

afterEach(cleanup);

describe('GridDivider', () => {
  describe('axis mapping', () => {
    it('resizes columns and leaves rows alone when vertical', () => {
      const { handle, onCommit } = setup('vertical');

      pointerDown(handle);
      pointerMoveTo(580, 500); // +0.08 horizontally, clear of every snap radius
      pointerUp();

      const [rows, cols] = onCommit.mock.calls[0] as [number[], number[]];
      expect(cols[0]).toBeCloseTo(0.58, 5);
      expect(rows).toEqual([0.5, 0.5]);
    });

    it('resizes rows and leaves columns alone when horizontal', () => {
      const { handle, onCommit } = setup('horizontal');

      pointerDown(handle);
      pointerMoveTo(500, 580); // +0.08 vertically, clear of every snap radius
      pointerUp();

      const [rows, cols] = onCommit.mock.calls[0] as [number[], number[]];
      expect(rows[0]).toBeCloseTo(0.58, 5);
      expect(cols).toEqual([0.5, 0.5]);
    });

    it('ignores movement inside the 3px dead zone', () => {
      const { handle, container } = setup('vertical');

      pointerDown(handle);
      pointerMoveTo(502, 500);

      expect(container.style.getPropertyValue('--grid-col-0')).toBe('');
    });
  });

  // Both grid axes stay operable by keyboard here. That is what keeps WCAG 2.1.1 satisfied after
  // GridCornerHandle — a mouse-only shortcut for the same resize — was removed from the tab order.
  describe('keyboard operation', () => {
    it('grows the leading column on ArrowRight when vertical', async () => {
      const { handle, onCommit } = setup('vertical');
      handle.focus();

      await userEvent.keyboard('{ArrowRight}');

      const [, cols] = onCommit.mock.calls[0] as [number[], number[]];
      expect(cols[0]).toBeCloseTo(0.52, 5);
    });

    it('shrinks the leading row on ArrowUp when horizontal', async () => {
      const { handle, onCommit } = setup('horizontal');
      handle.focus();

      await userEvent.keyboard('{ArrowUp}');

      const [rows] = onCommit.mock.calls[0] as [number[], number[]];
      expect(rows[0]).toBeCloseTo(0.48, 5);
    });

    it('resets to equal sizes on Enter', async () => {
      const { handle, onResetToEqual } = setup('vertical');
      handle.focus();

      await userEvent.keyboard('{Enter}');

      expect(onResetToEqual).toHaveBeenCalledOnce();
    });

    it('is reachable in the tab order', () => {
      const { handle } = setup('vertical');
      expect(handle.tabIndex).toBe(0);
    });
  });

  it('ignores macOS Ctrl+click', () => {
    const { handle, container, onCommit } = setup('vertical');

    pointerDown(handle, { ctrlKey: true });
    pointerMoveTo(700, 500);
    pointerUp();

    expect(container.style.getPropertyValue('--grid-col-0')).toBe('');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
