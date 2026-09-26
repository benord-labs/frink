/**
 * Layout stub for usePriorityOverflow tests: happy-dom has no layout and its ResizeObserver never
 * fires, so this reports a layout on observe and gives the container and every element a width.
 */

/** Width reported for buttons, so the "more" control measures narrower than a chip. */
const BUTTON_WIDTH_PX = 24;

type Widths = { containerWidth: number; itemWidth: number };

export function stubLayout(containerWidth: number, itemWidth: number) {
  const widths: Widths = { containerWidth, itemWidth };
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const originalResizeObserver = globalThis.ResizeObserver;
  const observers = new Set<FakeResizeObserver>();

  class FakeResizeObserver implements ResizeObserver {
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe(target: Element) {
      // SAFETY: the hook under test reads no entry fields, only that a report happened.
      const entry = { target } as ResizeObserverEntry;
      this.callback([entry], this);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this);
    }
  }

  globalThis.ResizeObserver = FakeResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    get: () => widths.containerWidth,
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get(this: HTMLElement) {
      return this.tagName === 'BUTTON' ? BUTTON_WIDTH_PX : widths.itemWidth;
    },
    configurable: true,
  });

  return {
    /** Change the reported widths without reporting them; pair with `fire` or a rerender. */
    set(nextContainerWidth: number, nextItemWidth: number) {
      widths.containerWidth = nextContainerWidth;
      widths.itemWidth = nextItemWidth;
    },
    /** Every live observer reports again, as a browser does after an observed element resizes. */
    fire() {
      for (const observer of observers) observer.callback([], observer);
    },
    restore() {
      globalThis.ResizeObserver = originalResizeObserver;
      for (const [name, descriptor] of [
        ['clientWidth', originalClientWidth],
        ['offsetWidth', originalOffsetWidth],
      ] as const) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, name);
      }
    },
  };
}
