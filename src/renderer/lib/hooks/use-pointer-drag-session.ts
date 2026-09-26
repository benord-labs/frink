import { useCallback, useEffect, useRef } from 'react';

/**
 * Excludes secondary buttons and Ctrl+primary — the latter is macOS's standard secondary click,
 * which arrives as button 0 alongside a `contextmenu` event, so treating it as a drag both hijacks
 * the menu and fires the caller's no-movement branch.
 */
function isPrimaryDragPointer(event: React.PointerEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.ctrlKey;
}

type DragSessionHandlers = {
  /** Fired for every pointermove until the session finishes. Apply the dead-zone threshold here. */
  onMove: (event: PointerEvent) => void;
  /** Fired once on pointerup or pointercancel, after teardown has completed. */
  onFinish: () => void;
};

/**
 * Captures the drag's starting state and returns the handlers for it. Runs only once the session is
 * committed to starting, so anything it does (marking the component as resizing, hiding a tooltip)
 * cannot fire on a click the session ends up ignoring.
 */
export type DragSessionSetup = (rect: DOMRect, container: HTMLElement) => DragSessionHandlers;

/**
 * Owns the lifecycle of a pointer-drag interaction: deciding whether the gesture starts one,
 * measuring the container it resizes against, pointer capture, the document-level
 * pointermove/pointerup/pointercancel listeners, and their teardown on finish or unmount.
 *
 * Callers keep their own `hasMoved` dead-zone flag: it means different things at different call
 * sites (a movement threshold everywhere, plus click-vs-drag discrimination in one) and the
 * thresholds are measured in different units.
 */
export function usePointerDragSession(): (
  event: React.PointerEvent<HTMLElement>,
  containerRef: React.RefObject<HTMLElement | null>,
  setup: DragSessionSetup,
) => void {
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  return useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      containerRef: React.RefObject<HTMLElement | null>,
      setup: DragSessionSetup,
    ) => {
      // Both bail-outs must precede preventDefault: swallowing a secondary click would suppress the
      // context menu these handles rely on.
      if (!isPrimaryDragPointer(event)) return;
      const container = containerRef.current;
      if (!container) return;

      event.preventDefault();
      event.stopPropagation();

      const target = event.currentTarget;
      const { pointerId } = event;
      const handlers = setup(container.getBoundingClientRect(), container);

      target.setPointerCapture?.(pointerId);

      // A second pointerdown before the first session ended would otherwise leave its listeners live.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      // Listeners are on document, so a second concurrent session (multi-touch, or a second pointing
      // device) would otherwise observe this one's events. Match on pointerId to keep sessions apart.
      const isOurPointer = (ev: PointerEvent) => ev.pointerId === pointerId;

      const onMove = (ev: PointerEvent) => {
        if (isOurPointer(ev)) handlers.onMove(ev);
      };

      const finish = (ev: PointerEvent) => {
        if (!isOurPointer(ev)) return;
        // Order matters: tear the session down completely before handing control back. onFinish may
        // unmount this component (closing a split), which must not happen with listeners still bound.
        controller.abort();
        if (abortRef.current === controller) abortRef.current = null;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture?.(pointerId);
        handlers.onFinish();
      };

      // No `once`: another pointer's pointerup would consume it before ours ever arrives. The
      // controller removes all three listeners when the session ends.
      document.addEventListener('pointermove', onMove, { signal });
      document.addEventListener('pointerup', finish, { signal });
      document.addEventListener('pointercancel', finish, { signal });
    },
    [],
  );
}
