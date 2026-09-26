// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { measureSlot } from './geometry';

const SCROLLPORT = new DOMRect(0, 0, 600, 700);
const DOCK_TOP = 500;

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
    expect(measureSlot(slot)).toEqual({
      bounds: { x: 0, y: 200, width: 600, height: 280 },
      pauseReason: null,
    });
  });

  // The native view paints above all DOM, so running it under the stack would cover the composer.
  it('pauses a slot that reaches under the chat bottom stack, though still inside the scrollport', () => {
    const slot = mountSlot(new DOMRect(0, 300, 600, 300));
    expect(measureSlot(slot)).toEqual({
      bounds: null,
      pauseReason: 'Interactive result paused while out of view.',
    });
  });
});
