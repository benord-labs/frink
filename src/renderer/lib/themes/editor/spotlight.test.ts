// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { largestOnScreen, showHoverBox, showSpotlight } from './spotlight';

// happy-dom has no checkVisibility; Chromium's opacity check covers ancestors too.
Element.prototype.checkVisibility = function (this: Element) {
  return !(this instanceof HTMLElement && this.style.opacity === '0');
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A div in `parent` whose layout box `rect` reports. */
function placed(rect: () => DOMRect, parent: Element = document.body): HTMLElement {
  const element = parent.appendChild(document.createElement('div'));
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(rect);
  return element;
}

/** Sets `overflow` as Chromium computes it, longhands included (happy-dom leaves them empty). */
function overflow(element: HTMLElement, x: string, y = x): void {
  Object.assign(element.style, { overflow: x === y ? x : `${x} ${y}`, overflowX: x, overflowY: y });
}

const at = (x: number, y: number, width: number, height: number) => () =>
  new DOMRect(x, y, width, height);

type Fade = { keyframes: Keyframe[]; reverse: () => void; onfinish: (() => void) | null };

/** happy-dom has no Web Animations: records each fade instead. */
function recordFades(): Map<Element, Fade> {
  const fades = new Map<Element, Fade>();
  function animate(this: Element, keyframes: Keyframe[]): Fade {
    const fade: Fade = { keyframes, reverse: vi.fn(), onfinish: null };
    fades.set(this, fade);
    return fade;
  }
  Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true });
  return fades;
}

describe('showSpotlight', () => {
  it('rings the target with its name and re-lays it in place on scroll', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    recordFades();
    let scrolled = 0;
    const target = placed(() => new DOMRect(10, 60 - scrolled, 200, 80));
    showSpotlight(target, 'Panels & sidebar');
    const ring = document.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(ring?.style.top).toBe(`${60 - 5}px`);
    expect(ring?.textContent).toBe('Panels & sidebar');
    expect(ring?.firstElementChild?.className).toContain('bg-primary');
    // Outside the target, so the tag hides none of it.
    expect(ring?.firstElementChild?.className).toContain('bottom-full');

    scrolled = 10;
    window.dispatchEvent(new Event('scroll'));
    for (const frame of frames.splice(0)) frame(0);
    expect(ring?.style.top).toBe(`${50 - 5}px`);
  });

  it("fades the workspace panels that don't hold the target, and fades them back", () => {
    const fades = recordFades();
    const row = document.body.appendChild(document.createElement('div'));
    const sidebar = placed(at(0, 0, 200, 600), row);
    const wrapper = row.appendChild(document.createElement('div'));
    wrapper.style.display = 'contents';
    const files = placed(at(200, 0, 200, 600), wrapper);
    const chat = placed(at(400, 0, 600, 600), row);
    const dock = row.appendChild(document.createElement('div'));
    dock.dataset.themeEditorDock = '';
    const target = placed(at(10, 10, 100, 20), sidebar);

    const hide = showSpotlight(sidebar, 'Text');
    // A panel as tall as the window takes its tag beside it.
    expect(document.querySelector('[aria-hidden="true"] > span')?.className).toContain('left-full');
    hide();
    fades.clear();
    showSpotlight(target, 'Text')();
    expect([...fades.keys()]).toEqual([files, chat]);
    expect(fades.get(chat)?.keyframes).toEqual([{ opacity: 0.38 }]);
    expect(fades.get(chat)?.reverse).toHaveBeenCalled();
    expect(fades.get(chat)?.onfinish).toBeTypeOf('function');
  });

  it('cuts the ring only on the axis its container clips', () => {
    recordFades();
    const strip = placed(at(0, 0, 200, 100));
    overflow(strip, 'clip', 'visible');
    showSpotlight(placed(at(10, 80, 100, 40), strip), 'Text');
    expect(document.querySelector<HTMLElement>('[aria-hidden="true"]')?.style.height).toBe(
      `${40 + 10}px`,
    );
  });

  it('clips the ring to its scroll container and hides it once scrolled out', () => {
    recordFades();
    const pane = placed(at(0, 0, 200, 100));
    overflow(pane, 'auto');
    showSpotlight(placed(at(10, 80, 100, 40), pane), 'Text');
    expect(document.querySelector<HTMLElement>('[aria-hidden="true"]')?.style.height).toBe(
      `${20 + 10}px`,
    );
    document.body.replaceChildren();

    const pane2 = placed(at(0, 0, 200, 100));
    overflow(pane2, 'auto');
    showSpotlight(placed(at(10, 300, 100, 40), pane2), 'Text');
    expect(document.querySelector<HTMLElement>('[aria-hidden="true"]')?.hidden).toBe(true);
  });
});

describe('largestOnScreen', () => {
  it('picks the match with the most area inside the window', () => {
    vi.stubGlobal('innerWidth', 1000);
    vi.stubGlobal('innerHeight', 800);
    const small = placed(at(0, 0, 50, 50));
    const offscreen = placed(at(0, 2000, 900, 900));
    const large = placed(at(100, 100, 300, 200));
    expect(largestOnScreen([small, offscreen, large])).toBe(large);
    expect(largestOnScreen([offscreen])).toBeNull();
  });

  it('passes over a larger match its scroll container clips out or that is see-through', () => {
    vi.stubGlobal('innerWidth', 1000);
    vi.stubGlobal('innerHeight', 800);
    const small = placed(at(0, 0, 50, 50));
    const pane = placed(at(0, 0, 400, 100));
    overflow(pane, 'auto');
    const clipped = placed(at(0, 300, 400, 200), pane);
    const faded = placed(at(500, 0, 300, 300));
    faded.style.opacity = '0';
    expect(largestOnScreen([clipped, faded, small])).toBe(small);
  });
});

describe('showHoverBox', () => {
  function hoverLabel(rect: DOMRect): string {
    showHoverBox(
      placed(() => rect),
      'Text',
    );
    return document.querySelector('#theme-inspector-hover > span')?.className ?? '';
  }

  it('puts the label inside a box it fits in', () => {
    expect(hoverLabel(new DOMRect(10, 10, 200, 60))).toContain('top-1.5 right-1.5');
  });

  it('measures the label in its own font before placing it', () => {
    vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLSpanElement) {
        // Unstyled, the label measures as wide as body text; in its own small font it fits.
        return new DOMRect(0, 0, this.className.includes('text-[11px]') ? 150 : 400, 16);
      },
    );
    expect(hoverLabel(new DOMRect(10, 10, 200, 60))).toContain('top-1.5 right-1.5');
  });

  it('puts a label that does not fit beside the box, or away from the rows around it', () => {
    vi.stubGlobal('innerWidth', 1000);
    vi.stubGlobal('innerHeight', 800);
    expect(hoverLabel(new DOMRect(10, 100, 100, 18))).toContain('left-full ml-1.5 top-1/2');
    expect(hoverLabel(new DOMRect(900, 100, 100, 18))).toContain('top-full mt-1.5 right-0');
    expect(hoverLabel(new DOMRect(900, 600, 100, 18))).toContain('bottom-full mb-1.5 right-0');
  });
});
