import type { ViewRect } from '../../../shared/types/browser';

const SLOT_TOLERANCE = 1;

type SlotClip = 'chat-scrollport' | 'element';
export type SlotMeasureOptions = { minWidth: number; minHeight: number; clip: SlotClip };
/** Why a slot cannot show its view right now. */
export type SlotBlock = 'hidden' | 'too-small' | 'out-of-view';
export type SlotMeasurement =
  | { bounds: ViewRect; block: null }
  | { bounds: null; block: SlotBlock };

type Edges = { top: number; right: number; bottom: number; left: number };

function chatScrollportEdges(element: HTMLElement): Edges {
  const scrollport = element.closest<HTMLElement>('[data-chat-container]');
  const scrollBounds = scrollport?.getBoundingClientRect() ?? {
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    left: 0,
  };
  // The native view paints above all DOM, so clip it at the top of ChatDock's stack or it covers
  // the composer. Rects, not scroll-padding: a split pane's CSS zoom scales rects, not computed px.
  const dock = scrollport?.parentElement?.querySelector('[data-chat-dock]');
  return {
    top: scrollBounds.top,
    right: scrollBounds.right,
    bottom: Math.min(scrollBounds.bottom, dock?.getBoundingClientRect().top ?? Infinity),
    left: scrollBounds.left,
  };
}

function visibleEdges(element: HTMLElement, clip: SlotClip): Edges {
  const bounds =
    clip === 'chat-scrollport'
      ? chatScrollportEdges(element)
      : { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 };
  const viewport = window.visualViewport;
  if (!viewport) return bounds;
  return {
    top: Math.max(bounds.top, viewport.offsetTop),
    right: Math.min(bounds.right, viewport.offsetLeft + viewport.width),
    bottom: Math.min(bounds.bottom, viewport.offsetTop + viewport.height),
    left: Math.max(bounds.left, viewport.offsetLeft),
  };
}

/** `visibility` inherits, so the slot's own computed style covers hidden ancestors too. */
function isRendered(element: HTMLElement): boolean {
  if (!element.isConnected || element.offsetParent === null) return false;
  return getComputedStyle(element).visibility !== 'hidden';
}

/** Where a native view may be drawn over `element`, or why it cannot be right now. */
export function measureSlot(element: HTMLElement, options: SlotMeasureOptions): SlotMeasurement {
  if (!isRendered(element)) return { bounds: null, block: 'hidden' };
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { bounds: null, block: 'hidden' };
  if (rect.width < options.minWidth || rect.height < options.minHeight) {
    return { bounds: null, block: 'too-small' };
  }
  const visible = visibleEdges(element, options.clip);
  if (
    rect.top < visible.top - SLOT_TOLERANCE ||
    rect.right > visible.right + SLOT_TOLERANCE ||
    rect.bottom > visible.bottom + SLOT_TOLERANCE ||
    rect.left < visible.left - SLOT_TOLERANCE
  ) {
    return { bounds: null, block: 'out-of-view' };
  }
  return { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, block: null };
}
