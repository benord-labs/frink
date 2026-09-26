import type { ArtifactPreviewBounds } from '../../../../shared/types/artifacts/html-artifact';

const MIN_SLOT_WIDTH = 280;
const MIN_SLOT_HEIGHT = 180;
const SLOT_TOLERANCE = 1;

export type SlotMeasurement =
  | { bounds: ArtifactPreviewBounds; pauseReason: null }
  | { bounds: null; pauseReason: string };

function visibleBoundsFor(element: HTMLElement) {
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
  const bounds = {
    top: scrollBounds.top,
    right: scrollBounds.right,
    bottom: Math.min(scrollBounds.bottom, dock?.getBoundingClientRect().top ?? Infinity),
    left: scrollBounds.left,
  };
  const viewport = window.visualViewport;
  if (!viewport) return bounds;
  return {
    top: Math.max(bounds.top, viewport.offsetTop),
    right: Math.min(bounds.right, viewport.offsetLeft + viewport.width),
    bottom: Math.min(bounds.bottom, viewport.offsetTop + viewport.height),
    left: Math.max(bounds.left, viewport.offsetLeft),
  };
}

export function measureSlot(element: HTMLElement): SlotMeasurement {
  const rect = element.getBoundingClientRect();
  if (!element.isConnected || element.offsetParent === null) {
    return { bounds: null, pauseReason: 'Interactive result paused.' };
  }
  if (rect.width < MIN_SLOT_WIDTH || rect.height < MIN_SLOT_HEIGHT) {
    return { bounds: null, pauseReason: 'Resize this pane to run the artifact.' };
  }
  const visible = visibleBoundsFor(element);
  if (
    rect.top < visible.top - SLOT_TOLERANCE ||
    rect.right > visible.right + SLOT_TOLERANCE ||
    rect.bottom > visible.bottom + SLOT_TOLERANCE ||
    rect.left < visible.left - SLOT_TOLERANCE
  ) {
    return { bounds: null, pauseReason: 'Interactive result paused while out of view.' };
  }
  return {
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    pauseReason: null,
  };
}
