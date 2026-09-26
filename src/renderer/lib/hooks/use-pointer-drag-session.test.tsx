// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePointerDragSession } from './use-pointer-drag-session';

type Handlers = { onMove: (e: PointerEvent) => void; onFinish: () => void };

/** Stands in for the element a drag measures against. */
function containerRefOf(container = document.createElement('div')) {
  const ref = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>;
  ref.current = container;
  return ref;
}

function Harness({
  handlers,
  testId = 'handle',
  containerRef = containerRefOf(),
}: {
  handlers: Handlers;
  testId?: string;
  containerRef?: React.RefObject<HTMLElement | null>;
}) {
  const startDragSession = usePointerDragSession();
  return (
    <button
      type="button"
      data-testid={testId}
      onPointerDown={(e) => startDragSession(e, containerRef, () => handlers)}
    />
  );
}

/** happy-dom has no PointerEvent, so carry pointerId on a MouseEvent for React to read. */
function pointerEvent(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
  const { pointerId = 1, ...mouseInit } = init;
  const event = new MouseEvent(type, { bubbles: true, ...mouseInit });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

/** happy-dom implements none of the pointer-capture API. */
function pointerDownOn(testId: string, pointerId = 1) {
  const handle = screen.getByTestId(testId);
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();
  handle.dispatchEvent(pointerEvent('pointerdown', { button: 0, pointerId }));
  return handle;
}

function makeHandlers(): Handlers {
  return { onMove: vi.fn(), onFinish: vi.fn() };
}

afterEach(cleanup);

describe('usePointerDragSession', () => {
  // These guards live in the hook precisely so they cannot drift between call sites — a duplicated
  // copy that tested only `button !== 0` is what let macOS Ctrl+click through as a drag.
  describe('refusing to start a session', () => {
    it.each([
      ['a secondary button', { button: 2 }],
      ['macOS Ctrl+click', { button: 0, ctrlKey: true }],
    ])('ignores %s', (_label, init) => {
      const handlers = makeHandlers();
      const setup = vi.fn(() => handlers);
      render(<Harness handlers={handlers} />);
      const handle = screen.getByTestId('handle');
      handle.setPointerCapture = vi.fn();
      handle.dispatchEvent(pointerEvent('pointerdown', init));

      document.dispatchEvent(pointerEvent('pointermove'));
      document.dispatchEvent(pointerEvent('pointerup'));

      expect(setup).not.toHaveBeenCalled();
      expect(handlers.onMove).not.toHaveBeenCalled();
      expect(handlers.onFinish).not.toHaveBeenCalled();
      expect(handle.setPointerCapture).not.toHaveBeenCalled();
    });

    it('ignores a pointerdown when the container is not mounted', () => {
      const handlers = makeHandlers();
      const emptyRef = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>;
      render(<Harness handlers={handlers} containerRef={emptyRef} />);
      pointerDownOn('handle');

      document.dispatchEvent(pointerEvent('pointermove'));

      expect(handlers.onMove).not.toHaveBeenCalled();
    });

    // Setup carries side effects (marking the pane as resizing, hiding a tooltip); running it for a
    // gesture the hook then ignores would leave the component stuck in a drag state.
    it('does not run setup until both guards pass', () => {
      const setup = vi.fn(() => makeHandlers());
      function Guarded() {
        const startDragSession = usePointerDragSession();
        const ref = containerRefOf();
        return (
          <button
            type="button"
            data-testid="guarded"
            onPointerDown={(e) => startDragSession(e, ref, setup)}
          />
        );
      }
      render(<Guarded />);
      const handle = screen.getByTestId('guarded');
      handle.setPointerCapture = vi.fn();

      handle.dispatchEvent(pointerEvent('pointerdown', { button: 2 }));
      expect(setup).not.toHaveBeenCalled();

      handle.dispatchEvent(pointerEvent('pointerdown', { button: 0 }));
      expect(setup).toHaveBeenCalledOnce();
    });

    it('measures the container and hands the rect to setup', () => {
      const container = document.createElement('div');
      container.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
      const setup = vi.fn(() => makeHandlers());
      function Measured() {
        const startDragSession = usePointerDragSession();
        const ref = containerRefOf(container);
        return (
          <button
            type="button"
            data-testid="measured"
            onPointerDown={(e) => startDragSession(e, ref, setup)}
          />
        );
      }
      render(<Measured />);
      const handle = screen.getByTestId('measured');
      handle.setPointerCapture = vi.fn();
      handle.dispatchEvent(pointerEvent('pointerdown', { button: 0 }));

      expect(setup).toHaveBeenCalledWith(
        expect.objectContaining({ width: 800, height: 600 }),
        container,
      );
    });
  });

  it('forwards document pointermove to onMove while the session is open', () => {
    const handlers = makeHandlers();
    render(<Harness handlers={handlers} />);
    pointerDownOn('handle');

    document.dispatchEvent(pointerEvent('pointermove'));
    document.dispatchEvent(pointerEvent('pointermove'));

    expect(handlers.onMove).toHaveBeenCalledTimes(2);
  });

  it.each(['pointerup', 'pointercancel'])('finishes the session on %s', (endEvent) => {
    const handlers = makeHandlers();
    render(<Harness handlers={handlers} />);
    pointerDownOn('handle');

    document.dispatchEvent(pointerEvent(endEvent));

    expect(handlers.onFinish).toHaveBeenCalledOnce();
  });

  it('stops forwarding pointermove once the session has finished', () => {
    const handlers = makeHandlers();
    render(<Harness handlers={handlers} />);
    pointerDownOn('handle');

    document.dispatchEvent(pointerEvent('pointerup'));
    document.dispatchEvent(pointerEvent('pointermove'));

    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it('releases pointer capture before handing control to onFinish', () => {
    const handlers = makeHandlers();
    render(<Harness handlers={handlers} />);
    const handle = pointerDownOn('handle');

    let releasesAtFinish: number | undefined;
    handlers.onFinish = vi.fn(() => {
      releasesAtFinish = (handle.releasePointerCapture as ReturnType<typeof vi.fn>).mock.calls
        .length;
    });
    document.dispatchEvent(pointerEvent('pointerup'));

    // Teardown must already have run when onFinish fires: onFinish may unmount the component.
    expect(releasesAtFinish).toBe(1);
  });

  it('abandons a previous session when the same element starts a new one', () => {
    const first = makeHandlers();
    const { rerender } = render(<Harness handlers={first} />);
    pointerDownOn('handle');

    const second = makeHandlers();
    rerender(<Harness handlers={second} />);
    pointerDownOn('handle');

    document.dispatchEvent(pointerEvent('pointermove'));
    document.dispatchEvent(pointerEvent('pointerup'));

    expect(first.onMove).not.toHaveBeenCalled();
    expect(first.onFinish).not.toHaveBeenCalled();
    expect(second.onMove).toHaveBeenCalledOnce();
    expect(second.onFinish).toHaveBeenCalledOnce();
  });

  // Two dividers can hold sessions simultaneously (multi-touch, or a second pointing device).
  // Each session must only observe its own pointer, or dragging one divider also resizes the other.
  describe('concurrent sessions on separate elements', () => {
    function renderTwo() {
      const a = makeHandlers();
      const b = makeHandlers();
      render(
        <>
          <Harness handlers={a} testId="a" />
          <Harness handlers={b} testId="b" />
        </>,
      );
      pointerDownOn('a', 1);
      pointerDownOn('b', 2);
      return { a, b };
    }

    it('routes pointermove only to the session whose pointer moved', () => {
      const { a, b } = renderTwo();

      document.dispatchEvent(pointerEvent('pointermove', { pointerId: 1 }));

      expect(a.onMove).toHaveBeenCalledOnce();
      expect(b.onMove).not.toHaveBeenCalled();
    });

    it('finishes only the session whose pointer was released', () => {
      const { a, b } = renderTwo();

      document.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }));

      expect(a.onFinish).toHaveBeenCalledOnce();
      expect(b.onFinish).not.toHaveBeenCalled();
    });
  });

  it('tears down a session still open at unmount', () => {
    const handlers = makeHandlers();
    const { unmount } = render(<Harness handlers={handlers} />);
    pointerDownOn('handle');

    unmount();
    document.dispatchEvent(pointerEvent('pointermove'));
    document.dispatchEvent(pointerEvent('pointerup'));

    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(handlers.onFinish).not.toHaveBeenCalled();
  });
});
