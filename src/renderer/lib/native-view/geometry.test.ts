// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { measureSlot } from './geometry';

const SCROLLPORT = new DOMRect(0, 0, 600, 700);
const DOCK_TOP = 500;
const ARTIFACT_SLOT = { minWidth: 280, minHeight: 180, clip: 'chat-scrollport' } as const;
const BROWSER_SLOT = { minWidth: 120, minHeight: 80, clip: 'element' } as const;

/**
 * The chat's layout as ChatDock builds it: the scrollport and the bottom stack are siblings, and
 * the stack covers the scrollport's last 200px. happy-dom performs no layout, so rects are fixed.
 */
function mountSlot(slotRect: DOMRect): HTMLElement {
  const region = document.createElement('div');
  const scrollport = document.createElement('div');
  scrollport.setAttribute('data-chat-container', '');
  const dock = document.createElement('div');
  dock.setAttribute('data-chat-dock', '');
  const slot = document.createElement('div');
  scrollport.append(slot);
  region.append(scrollport, dock);
  document.body.append(region);

  scrollport.getBoundingClientRect = () => SCROLLPORT;
  dock.getBoundingClientRect = () => new DOMRect(0, DOCK_TOP, 600, SCROLLPORT.bottom - DOCK_TOP);
  slot.getBoundingClientRect = () => slotRect;
  Object.defineProperty(slot, 'offsetParent', { get: () => scrollport });
  return slot;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('measureSlot', () => {
  it('runs a slot that ends above the chat bottom stack', () => {
    const slot = mountSlot(new DOMRect(0, 200, 600, 280));
    expect(measureSlot(slot, ARTIFACT_SLOT)).toEqual({
      bounds: { x: 0, y: 200, width: 600, height: 280 },
      block: null,
    });
  });

  // The native view paints above all DOM, so running it under the stack would cover the composer.
  it('pauses a slot that reaches under the chat bottom stack, though still inside the scrollport', () => {
    const slot = mountSlot(new DOMRect(0, 300, 600, 300));
    expect(measureSlot(slot, ARTIFACT_SLOT)).toEqual({ bounds: null, block: 'out-of-view' });
  });

  // A browser slot in a side panel is not inside the chat scrollport, so only the window clips it.
  it('ignores the chat bottom stack for an element-clipped slot', () => {
    const slot = mountSlot(new DOMRect(0, 300, 600, 300));
    expect(measureSlot(slot, BROWSER_SLOT).block).toBeNull();
  });

  it('reports a slot under a visibility:hidden ancestor, or with no size, as hidden', () => {
    const slot = mountSlot(new DOMRect(0, 200, 600, 280));
    slot.parentElement?.style.setProperty('visibility', 'hidden');
    expect(measureSlot(slot, BROWSER_SLOT)).toEqual({ bounds: null, block: 'hidden' });
    slot.parentElement?.style.removeProperty('visibility');
    slot.getBoundingClientRect = () => new DOMRect(0, 200, 0, 0);
    expect(measureSlot(slot, BROWSER_SLOT)).toEqual({ bounds: null, block: 'hidden' });
  });
});
