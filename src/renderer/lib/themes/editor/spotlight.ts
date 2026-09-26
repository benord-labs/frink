import { overlayGlass } from '@/lib/overlay-styles';

const HOVER_ID = 'theme-inspector-hover';
const PADDING = 5;
const FADE_MS = 120;
const DIM_OPACITY = 0.38;

// z-39: over the app's own layers, under its popovers and tooltips (z-50).
const HOVER_CLASS =
  'pointer-events-none fixed z-39 border border-ring bg-ring/5 shadow-[0_0_0_3px_hsl(var(--ring)/0.16),0_0_18px_hsl(var(--ring)/0.38)]';
const LABEL_CLASS = `absolute max-w-48 truncate rounded-md border px-1.5 py-0.5 text-[11px] leading-4 font-semibold text-popover-foreground shadow-md ${overlayGlass}`;
const SPOTLIGHT_CLASS =
  'pointer-events-none fixed z-39 shadow-[0_0_0_2px_hsl(var(--primary)),0_0_0_6px_hsl(var(--primary)/0.18)]';
const TAG_CLASS =
  'absolute max-w-48 truncate rounded-md bg-primary px-2 py-0.5 text-[11px] leading-4 font-semibold text-primary-foreground shadow-md';
const FADE_IN_CLASS = 'animate-in fade-in duration-120 motion-reduce:animate-none';
const FADE_OUT_CLASS = 'animate-out fade-out fill-mode-forwards duration-120';

type Box = { x: number; y: number; width: number; height: number; radius: number };

function cornerRadius(element: Element): number {
  return Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const CLIPPING_OVERFLOW = /auto|scroll|hidden|clip/;
const SHOWN = { opacityProperty: true, visibilityProperty: true };

function area({ width, height }: DOMRectReadOnly): number {
  return width * height;
}

/** The overlap of two rects; empty (zero-sized) when they miss. */
function intersect(a: DOMRectReadOnly, b: DOMRectReadOnly): DOMRect {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const width = Math.max(0, Math.min(a.right, b.right) - left);
  return new DOMRect(left, top, width, Math.max(0, Math.min(a.bottom, b.bottom) - top));
}

function viewport(): DOMRect {
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

/** `rect` cut to `parent` on each axis whose overflow `parent` clips or scrolls. */
function clipTo(rect: DOMRect, parent: Element): DOMRect {
  const { overflowX, overflowY } = getComputedStyle(parent);
  const [clipX, clipY] = [CLIPPING_OVERFLOW.test(overflowX), CLIPPING_OVERFLOW.test(overflowY)];
  if (!clipX && !clipY) return rect;
  const box = parent.getBoundingClientRect();
  const [left, width] = clipX ? [box.left, box.width] : [rect.left, rect.width];
  const [top, height] = clipY ? [box.top, box.height] : [rect.top, rect.height];
  return intersect(rect, new DOMRect(left, top, width, height));
}

/** `element`'s rect cut to the window and every ancestor that clips or scrolls its overflow. */
function visibleRect(element: Element): DOMRect {
  let rect = intersect(element.getBoundingClientRect(), viewport());
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    rect = clipTo(rect, parent);
  }
  return rect;
}

/** The element's padded visible box, or null when none of it shows. */
function paddedBox(element: Element): Box | null {
  const rect = visibleRect(element);
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left - PADDING,
    y: rect.top - PADDING,
    width: rect.width + PADDING * 2,
    height: rect.height + PADDING * 2,
    radius: Math.min(18, Math.max(7, cornerRadius(element) + PADDING)),
  };
}

/** A fixed frame holding one label, left for `placeFrame` to position. */
function createFrame(className: string): HTMLElement {
  const frame = document.createElement('div');
  frame.className = className;
  frame.setAttribute('aria-hidden', 'true');
  // Tagged like the editor, so a frame fading out is never counted as a place a role shows.
  frame.setAttribute('data-theme-editor-panel', '');
  frame.append(document.createElement('span'));
  document.body.append(frame);
  return frame;
}

/** Where the label sits: inside the box's top-right corner when it fits, else beside it on the
 * same row; with no room on the right, below it in the window's top half, above in the bottom. */
function labelPlacement(box: Box, labelWidth: number): string {
  if (box.width >= labelWidth + 12 && box.height >= 32) return 'top-1.5 right-1.5';
  if (box.x + box.width + 6 + labelWidth <= window.innerWidth) {
    return 'left-full ml-1.5 top-1/2 -translate-y-1/2';
  }
  const inTopHalf = box.y + box.height / 2 < window.innerHeight / 2;
  return `${inTopHalf ? 'top-full mt-1.5' : 'bottom-full mb-1.5'} right-0`;
}

/**
 * Where the spotlight's tag sits: on the ring, outside the target so it hides none of it. Above
 * when there is room, else beside a target that fills the window's height, else inside.
 */
function tagPlacement(box: Box, tagWidth: number): string {
  if (box.y >= 24) return 'bottom-full mb-1.5 left-0';
  if (box.x + box.width + 10 + tagWidth <= window.innerWidth) return 'left-full ml-2.5 top-[46%]';
  return 'top-1.5 left-1.5';
}

type Placement = (box: Box, labelWidth: number) => string;

/** Lays `frame` over `box` with `label` in its label slot. */
function placeFrame(
  frame: HTMLElement,
  box: Box,
  label: string,
  labelClass: string,
  placement: Placement = labelPlacement,
): void {
  Object.assign(frame.style, {
    left: `${box.x}px`,
    top: `${box.y}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: `${box.radius}px`,
  });
  const tag = frame.firstElementChild;
  if (!tag) return;
  tag.textContent = label;
  // Measured in its own font and padding, so placement judges the width it will paint at.
  tag.className = labelClass;
  tag.className = `${labelClass} ${placement(box, tag.getBoundingClientRect().width)}`;
}

export function clearHoverBox(): void {
  document.getElementById(HOVER_ID)?.remove();
}

/** Outlines `element` with `label` on it. */
export function showHoverBox(element: Element, label: string): void {
  const box = paddedBox(element);
  if (!box) {
    clearHoverBox();
    return;
  }
  let hover = document.getElementById(HOVER_ID);
  if (!hover) {
    hover = createFrame(HOVER_CLASS);
    hover.id = HOVER_ID;
  }
  placeFrame(hover, box, label, LABEL_CLASS);
}

/** The match with the most area showing (unclipped, not see-through): the one a spotlight rings. */
export function largestOnScreen(elements: readonly Element[]): Element | null {
  let largest: Element | null = null;
  let largestArea = 0;
  for (const element of elements) {
    // Its window overlap caps what shows, so most matches skip the walk up their ancestors.
    if (area(intersect(element.getBoundingClientRect(), viewport())) <= largestArea) continue;
    const showing = area(visibleRect(element));
    if (showing > largestArea && element.checkVisibility(SHOWN)) {
      largest = element;
      largestArea = showing;
    }
  }
  return largest;
}

/**
 * The workspace's panels beside the docked editor (its row siblings), looking through
 * `display: contents` wrappers, which have no box to fade.
 */
function workspacePanels(): Element[] {
  const dock = document.querySelector('[data-theme-editor-dock]');
  const row = dock?.parentElement;
  if (!dock || !row) return [];
  return [...row.children]
    .flatMap((child) =>
      getComputedStyle(child).display === 'contents' ? [...child.children] : [child],
    )
    .filter((panel) => panel !== dock);
}

/** Fades every workspace panel but `target`'s; returns the fade back. */
function dimOtherPanels(target: Element): () => void {
  const timing = { duration: reducedMotion() ? 0 : FADE_MS, fill: 'forwards' as const };
  const fades = workspacePanels()
    .filter((panel) => !panel.contains(target))
    .map((panel) => panel.animate([{ opacity: DIM_OPACITY }], timing));
  return () => {
    for (const fade of fades) {
      fade.onfinish = () => fade.cancel();
      fade.reverse();
    }
  };
}

/**
 * Rings `target` in the accent with `label` on it, and fades the other workspace panels, re-laid
 * in place on scroll and resize. Returns the teardown, which fades it all back.
 */
export function showSpotlight(target: Element, label: string): () => void {
  const frame = createFrame(`${SPOTLIGHT_CLASS} ${FADE_IN_CLASS}`);
  const paint = () => {
    const box = paddedBox(target);
    frame.hidden = !box;
    if (box) placeFrame(frame, box, label, TAG_CLASS, tagPlacement);
  };
  paint();
  const undim = dimOtherPanels(target);

  let frameRequest = 0;
  const relayout = () => {
    frameRequest ||= requestAnimationFrame(() => {
      frameRequest = 0;
      paint();
    });
  };
  window.addEventListener('resize', relayout);
  // Capture: scrolls inside panes don't bubble to the window.
  window.addEventListener('scroll', relayout, true);
  return () => {
    cancelAnimationFrame(frameRequest);
    window.removeEventListener('resize', relayout);
    window.removeEventListener('scroll', relayout, true);
    undim();
    frame.className = `${SPOTLIGHT_CLASS} ${FADE_OUT_CLASS}`;
    setTimeout(() => frame.remove(), reducedMotion() ? 0 : FADE_MS);
  };
}
