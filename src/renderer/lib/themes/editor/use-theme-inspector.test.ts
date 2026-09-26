// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { themeEditorSelectedRoleAtom } from './editor-atoms';
import { useThemeInspector } from './use-theme-inspector';

// happy-dom has no checkVisibility; like Chromium's opacity check, this one covers ancestors.
Element.prototype.checkVisibility = function (this: Element) {
  return this.closest('.opacity-0') === null;
};

function byId(id: string): Element {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element;
}

function arm() {
  const hook = renderHook(() => useThemeInspector(false));
  act(() => hook.result.current.toggle());
  return hook;
}

/** An app box the border role paints, laid out at `rect`. */
function borderBox(rect: DOMRect, parent: Element = document.body): HTMLElement {
  document.documentElement.style.setProperty('--border', 'red');
  const box = parent.appendChild(document.createElement('div'));
  box.style.backgroundColor = 'var(--border)';
  vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(rect);
  return box;
}

/** A pointer press on `element`, and its click unless something else took it. */
function press(element: Element, clicked = true): void {
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    if (clicked) element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
}

/** The spotlight ring's width; a ring fading out is already on its way off screen. */
function ringWidth(): string | undefined {
  return [...document.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(
    (ring) => !ring.className.includes('animate-out'),
  )?.style.width;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getDefaultStore().set(themeEditorSelectedRoleAtom, null);
  document.documentElement.removeAttribute('style');
  document.body.replaceChildren();
});

describe('useThemeInspector while armed', () => {
  it('leaves keyboard activation to the app but swallows a pointer press and its click', () => {
    document.body.innerHTML = '<button id="app">Go</button>';
    const onClick = vi.fn();
    byId('app').addEventListener('click', onClick);
    arm();

    // Enter/Space: a click with no press before it.
    act(() => byId('app').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => {
      byId('app').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      byId('app').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['nothing (a macOS Ctrl+click opens the context menu)', null],
    ['a pointercancel (the press became a scroll)', () => new PointerEvent('pointercancel')],
    ['a dragstart (the press became a native drag)', () => new DragEvent('dragstart')],
  ])(
    'forgets a press followed by %s, so the next keyboard activation reaches the app',
    (_, followUp) => {
      document.body.innerHTML = '<button id="app">Go</button>';
      const onClick = vi.fn();
      byId('app').addEventListener('click', onClick);
      arm();

      act(() => {
        byId('app').dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: true }),
        );
        if (followUp) byId('app').dispatchEvent(followUp());
      });
      act(() => byId('app').dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(onClick).toHaveBeenCalledTimes(1);
    },
  );

  it('quiets the app’s own tooltips until disarmed, without blocking drags', () => {
    document.body.innerHTML = '<div id="row" title="Empty chat"><span id="name">x</span></div>';
    const onMove = vi.fn();
    document.body.addEventListener('pointermove', onMove);
    const { result } = arm();

    byId('name').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    expect(byId('row').hasAttribute('title')).toBe(false);
    byId('name').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    expect(onMove).not.toHaveBeenCalled();
    byId('name').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1 }));
    expect(onMove).toHaveBeenCalledTimes(1);

    act(() => result.current.toggle());
    expect(byId('row').getAttribute('title')).toBe('Empty chat');
    document.body.removeEventListener('pointermove', onMove);
  });

  it('lets go as soon as a press picks, and still swallows its click after a suspend', () => {
    const swatch = borderBox(new DOMRect(0, 0, 40, 20));
    const onClick = vi.fn();
    document.body.addEventListener('click', onClick);
    const { result, rerender } = renderHook(({ suspended }) => useThemeInspector(suspended), {
      initialProps: { suspended: false },
    });
    act(() => result.current.toggle());

    press(swatch, false);
    expect(result.current.armed).toBe(false);
    // Something covers the app and goes again before the press's click lands.
    rerender({ suspended: true });
    rerender({ suspended: false });
    act(() => void swatch.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(onClick).not.toHaveBeenCalled();

    // A later click is the app's again.
    press(swatch);
    expect(onClick).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('click', onClick);
  });
});

describe('useThemeInspector spotlight', () => {
  it('rings the largest use of a role once the pick that chose it is cleared', async () => {
    const swatch = borderBox(new DOMRect(0, 0, 40, 20));
    borderBox(new DOMRect(100, 100, 300, 200));
    const { result } = arm();

    press(swatch);
    expect(ringWidth()).toBe('50px');
    act(() => result.current.clear());
    act(() => result.current.hover('border'));
    await waitFor(() => expect(ringWidth()).toBe('310px'));
  });

  it("ends a row's preview on a click in the app and keeps the picked selection", async () => {
    const swatch = borderBox(new DOMRect(0, 0, 40, 20));
    const app = borderBox(new DOMRect(100, 100, 300, 200));
    const { result } = arm();
    press(swatch);
    act(() => result.current.hover('text'));
    await waitFor(() => expect(result.current.usage?.role).toBe('text'));

    press(app);
    expect(getDefaultStore().get(themeEditorSelectedRoleAtom)).toBe('border');
    await waitFor(() => expect(result.current.usage?.role).toBe('border'));
  });

  it('rings and counts only the uses still showing once the clicked element is hidden', () => {
    const tab = document.body.appendChild(document.createElement('div'));
    const swatch = borderBox(new DOMRect(0, 0, 40, 20), tab);
    borderBox(new DOMRect(100, 100, 300, 200));
    const { result, rerender } = renderHook(({ suspended }) => useThemeInspector(suspended), {
      initialProps: { suspended: false },
    });
    act(() => result.current.toggle());
    press(swatch);

    // A keep-alive chat tab is hidden, then something covers the app and goes again.
    tab.className = 'opacity-0';
    rerender({ suspended: true });
    rerender({ suspended: false });
    expect(ringWidth()).toBe('310px');
    expect(result.current.usage).toEqual({ role: 'border', count: 1 });
  });
});
