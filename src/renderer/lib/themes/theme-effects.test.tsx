// @vitest-environment happy-dom
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCodeTheme, useIsLightCode } from '../hooks/use-code-theme';
import { paintStoredTheme } from './paint-theme';
import { applyPalette } from './palette/apply';
import { hexToHslTriplet } from './palette/color';
import {
  activePaletteAtom,
  contrastAtom,
  previewActiveAtom,
  themeHalvesAtom,
  transparencyAtom,
} from './palette/theme-atoms';
import { installStockSheet } from './stock-sheet-fixture';
import { ThemeEffects } from './theme-effects';

const STOCK = installStockSheet();

const colourScheme = { prefersDark: true };
const queries: ColourSchemeQuery[] = [];

/** happy-dom ships no matchMedia, and next-themes needs one to resolve system mode. */
class ColourSchemeQuery extends EventTarget {
  readonly onchange = null;

  constructor(readonly media: string) {
    super();
    queries.push(this);
  }

  get matches(): boolean {
    return this.media.includes('dark') ? colourScheme.prefersDark : !colourScheme.prefersDark;
  }

  addListener(listener: EventListener): void {
    this.addEventListener('change', listener);
  }

  removeListener(listener: EventListener): void {
    this.removeEventListener('change', listener);
  }
}

/** Flips the OS appearance as Chromium reports it: listeners see the change as `window.event`. */
function flipComputerAppearance(dark: boolean): void {
  colourScheme.prefersDark = dark;
  for (const query of [...queries]) {
    const change = new MediaQueryListEvent('change', { matches: dark, media: query.media });
    Object.defineProperty(window, 'event', { configurable: true, value: change });
    query.dispatchEvent(change);
  }
  Reflect.deleteProperty(window, 'event');
}

const html = document.documentElement;
const inline = (name: string): string => html.style.getPropertyValue(name);

const renderEffects = (store: ReturnType<typeof createStore>) =>
  render(
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <Provider store={store}>
        <ThemeEffects>
          <span>child</span>
        </ThemeEffects>
      </Provider>
    </ThemeProvider>,
  );

describe('ThemeEffects', () => {
  beforeEach(() => {
    localStorage.clear();
    queries.length = 0;
    colourScheme.prefersDark = true;
    window.matchMedia = (query: string) => new ColourSchemeQuery(query);
    html.className = '';
    html.removeAttribute('style');
  });

  it('leaves stock Frink to globals.css but still commits its palette', () => {
    const store = createStore();
    renderEffects(store);

    expect(store.get(activePaletteAtom)).toMatchObject({
      themeId: 'frink',
      appearance: 'dark',
      syntax: 'github-dark',
      stock: true,
    });
    expect(inline('--background')).toBe('');
    expect(html.dataset.themeId).toBe('frink');
  });

  it('paints the half for the OS appearance', () => {
    colourScheme.prefersDark = false;
    const store = createStore();
    store.set(themeHalvesAtom, { light: 'clay', dark: 'moss' });
    renderEffects(store);

    expect(store.get(activePaletteAtom)).toMatchObject({ themeId: 'clay', appearance: 'light' });
    expect(inline('--background')).toBe(hexToHslTriplet('#faf9f5'));
  });

  it('repaints an OS appearance flip in the frame its class changes', async () => {
    colourScheme.prefersDark = false;
    const store = createStore();
    store.set(themeHalvesAtom, { light: 'clay', dark: 'clay' });
    renderEffects(store);
    expect(inline('--background')).toBe(hexToHslTriplet('#faf9f5'));

    flipComputerAppearance(true);
    // Microtasks only: a frame can paint at the next task, never before this await resumes.
    await Promise.resolve();

    expect(html.classList.contains('dark')).toBe(true);
    expect(inline('--background')).toBe(hexToHslTriplet('#262624'));
  });

  it('follows a new theme pick after mount', () => {
    const store = createStore();
    renderEffects(store);

    act(() => store.set(themeHalvesAtom, { light: 'frink', dark: 'tide' }));

    expect(store.get(activePaletteAtom)?.syntax).toBe('min-dark');
    expect(inline('--background')).toBe(hexToHslTriplet('#1f1f1f'));
  });

  it('falls back to Frink when a half points at a theme that no longer exists', () => {
    const store = createStore();
    store.set(themeHalvesAtom, { light: 'frink', dark: 'deleted-theme' });

    expect(() => renderEffects(store)).not.toThrow();
    expect(store.get(activePaletteAtom)?.themeId).toBe('frink');
  });

  it('writes stock inline once contrast moves off 100', () => {
    const store = createStore();
    renderEffects(store);

    act(() => store.set(contrastAtom, 130));

    expect(inline('--foreground')).not.toBe('');
    expect(store.get(activePaletteAtom)?.inline).toBe(true);
  });

  it('writes the glass vars for the transparency level and appearance, without transitions', async () => {
    const store = createStore();
    renderEffects(store);
    expect(inline('--glass-rim')).toBe('0.19');
    await waitFor(() => expect(html.classList.contains('theme-switching')).toBe(false));

    act(() => store.set(transparencyAtom, 0));

    expect(inline('--glass-opacity')).toBe('100%');
    expect(inline('--glass-filter')).toBe('none');
    expect(html.classList.contains('theme-switching')).toBe(true);
  });

  it('stands down while the editor preview owns <html>, then restores the stored theme', () => {
    const store = createStore();
    renderEffects(store);

    act(() => store.set(previewActiveAtom, true));
    act(() => store.set(themeHalvesAtom, { light: 'frink', dark: 'clay' }));
    expect(store.get(activePaletteAtom)?.themeId).toBe('frink');
    expect(inline('--background')).toBe('');

    act(() => store.set(previewActiveAtom, false));
    expect(store.get(activePaletteAtom)?.themeId).toBe('clay');
    expect(inline('--background')).toBe(hexToHslTriplet('#262624'));
  });

  it("saves each non-stock half's window colour for the boot loader", () => {
    const store = createStore();
    store.set(themeHalvesAtom, { light: 'frink', dark: 'clay' });
    renderEffects(store);

    expect(JSON.parse(localStorage.getItem('frink:boot-bg') ?? '')).toEqual({ dark: '#262624' });
  });

  it('removes its vars on unmount', () => {
    const store = createStore();
    store.set(themeHalvesAtom, { light: 'clay', dark: 'clay' });
    const { unmount } = renderEffects(store);
    expect(inline('--background')).not.toBe('');

    unmount();

    expect(inline('--background')).toBe('');
    expect(html.dataset.themeId).toBeUndefined();
  });

  it('keeps the palette boot painted when nothing has changed', () => {
    html.className = 'dark';
    const store = createStore();
    paintStoredTheme(store);
    const boot = store.get(activePaletteAtom);

    renderEffects(store);

    expect(store.get(activePaletteAtom)).toBe(boot);
  });

  it('repaints the stored theme over an uncommitted preview frame', () => {
    const store = createStore();
    renderEffects(store);
    act(() => store.set(previewActiveAtom, true));
    const frame = { themeId: 'draft', syntax: 'github-dark', stock: false, inline: true } as const;
    applyPalette({ ...frame, appearance: 'dark', colors: STOCK.dark });
    expect(inline('--background')).not.toBe('');

    act(() => store.set(previewActiveAtom, false));

    expect(inline('--background')).toBe('');
  });

  it('renders its children', () => {
    const { getByText } = renderEffects(createStore());
    expect(getByText('child')).toBeTruthy();
  });
});

describe('code theme hooks', () => {
  beforeEach(() => {
    colourScheme.prefersDark = false;
    window.matchMedia = (query: string) => new ColourSchemeQuery(query);
    html.className = '';
  });

  it('pair the Shiki theme with light or dark, before and after a palette is committed', () => {
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <Provider store={store}>{children}</Provider>
      </ThemeProvider>
    );
    const { result } = renderHook(() => ({ theme: useCodeTheme(), light: useIsLightCode() }), {
      wrapper,
    });
    expect(result.current).toEqual({ theme: 'github-dark', light: false });

    act(() => paintStoredTheme(store));
    expect(result.current).toEqual({ theme: 'github-light', light: true });
  });
});
