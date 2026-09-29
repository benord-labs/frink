// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { ThemeProvider } from 'next-themes';
import { toast, Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { themeEditorDraftNameAtom, themeEditorSessionAtom } from '@/lib/themes/editor/editor-atoms';
import { findTheme } from '@/lib/themes/palette/built-in-themes';
import { hexToHslTriplet } from '@/lib/themes/palette/color';
import { glassVars } from '@/lib/themes/palette/glass';
import {
  activePaletteAtom,
  contrastAtom,
  customThemesAtom,
  previewActiveAtom,
  themeHalvesAtom,
  transparencyAtom,
} from '@/lib/themes/palette/theme-atoms';
import type { ThemeDefinition } from '@/lib/themes/palette/theme-schema';
import { installStockSheet } from '@/lib/themes/stock-sheet-fixture';
import { ThemeEffects } from '@/lib/themes/theme-effects';
import { TooltipProvider } from '../../ui/tooltip';
import { AgentsAppearanceTab } from './agents-appearance-tab';

const STOCK = installStockSheet();
afterEach(() => {
  cleanup();
  toast.dismiss();
  Reflect.deleteProperty(document, 'startViewTransition');
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
});

const MINE: ThemeDefinition = {
  id: 'mine',
  name: 'Mine',
  light: { background: '#fff7fa', accent: '#bc2b72', syntax: 'github-light' },
  dark: { background: '#1c1519', accent: '#ff8cc6', syntax: 'github-dark' },
};

function renderTab(store = createStore()) {
  render(
    <Provider store={store}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <TooltipProvider>
          <AgentsAppearanceTab />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </Provider>,
  );
  return store;
}

const button = (name: string) => screen.getByRole('button', { name });
const radio = (name: string) => screen.getByRole('radio', { name });

/** Whether a theme's strip for one appearance shows it in use. */
const strip = (themeName: string, appearance: 'light' | 'dark') =>
  button(`Use ${themeName} for ${appearance}`);

/** Renders the tab inside the app's ThemeEffects; `closeTab` unmounts only the tab. */
function renderInThemeEffects(store: ReturnType<typeof createStore>) {
  const tree = (showTab: boolean) => (
    <Provider store={store}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <ThemeEffects>
          <TooltipProvider>{showTab ? <AgentsAppearanceTab /> : null}</TooltipProvider>
        </ThemeEffects>
      </ThemeProvider>
    </Provider>
  );
  const { rerender } = render(tree(true));
  return { closeTab: () => rerender(tree(false)) };
}

/** Makes `(prefers-reduced-motion: reduce)` match `reduced`; other queries stay real. */
function stubReducedMotion(reduced: boolean) {
  const real = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const list = real(query);
    if (query.includes('prefers-reduced-motion')) {
      Object.defineProperty(list, 'matches', { value: reduced });
    }
    return list;
  });
}

/** Makes the OS's solid-panels query switchable; the returned setter flips it and notifies. */
function stubSolidPanels(): (solid: boolean) => void {
  const real = window.matchMedia.bind(window);
  const state = { solid: false };
  let query: MediaQueryList | undefined;
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => {
    if (!media.includes('prefers-reduced-transparency')) return real(media);
    query ??= real(media);
    Object.defineProperty(query, 'matches', { configurable: true, get: () => state.solid });
    return query;
  });
  return (solid) => {
    state.solid = solid;
    query?.dispatchEvent(new Event('change'));
  };
}

type Snapshot = { cls: string; scheme: string; bg: string; id: string | undefined };

/** A view-transition API that runs each update at once and records <html> as it returns. */
function stubViewTransition() {
  const html = document.documentElement;
  const snapshots: Snapshot[] = [];
  const start = vi.fn((update: () => void) => {
    update();
    snapshots.push({
      cls: html.className,
      scheme: html.style.colorScheme,
      bg: html.style.getPropertyValue('--background'),
      id: html.dataset.themeId,
    });
    const done = Promise.resolve();
    return { finished: done, ready: done, updateCallbackDone: done, skipTransition() {} };
  });
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
  return { start, snapshots };
}

/** A view-transition API that holds each update until the test runs it. */
function stubDeferredViewTransition(): (() => void)[] {
  const pending: (() => void)[] = [];
  const start = vi.fn((update: () => void) => {
    pending.push(update);
    const done = Promise.resolve();
    return { finished: done, ready: done, updateCallbackDone: done, skipTransition() {} };
  });
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
  return pending;
}

/** Renders with MINE painting dark mode and its ⋯ menu open. */
function renderWithMenuOpen() {
  const store = createStore();
  store.set(customThemesAtom, () => [MINE]);
  store.set(themeHalvesAtom, { light: 'frink', dark: 'mine' });
  renderTab(store);
  fireEvent.keyDown(button('More for Mine'), { key: 'Enter' });
  return store;
}

describe('AgentsAppearanceTab themes', () => {
  it('uses a theme in both appearances from its row, and in one from a strip', () => {
    const store = renderTab();
    expect(button('Use Frink in light and dark')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(button('Use Clay in light and dark'));
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'clay', dark: 'clay' });
    expect(button('Use Clay in light and dark')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(strip('Moss', 'dark'));
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'clay', dark: 'moss' });
    expect(button('Use Clay in light and dark')).toHaveAttribute('aria-pressed', 'false');
    expect(strip('Clay', 'light')).toHaveAttribute('aria-pressed', 'true');
    expect(strip('Clay', 'dark')).toHaveAttribute('aria-pressed', 'false');
    expect(strip('Moss', 'dark')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(button('Use Tide in light and dark'));
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'tide', dark: 'tide' });
  });

  it('reaches a row by keyboard as name, Light strip, Dark strip, then ⋯', async () => {
    const store = createStore();
    store.set(customThemesAtom, () => [MINE]);
    renderTab(store);
    const user = userEvent.setup();
    button('Use Mine in light and dark').focus();
    for (const name of ['Use Mine for light', 'Use Mine for dark', 'More for Mine']) {
      await user.tab();
      expect(button(name)).toHaveFocus();
    }
  });

  it('marks each half of a split pick and announces each pick', () => {
    const store = createStore();
    store.set(themeHalvesAtom, { light: 'sprinkles', dark: 'tide' });
    renderTab(store);
    expect(strip('Sprinkles', 'light')).toHaveAttribute('aria-pressed', 'true');
    expect(strip('Tide', 'dark')).toHaveAttribute('aria-pressed', 'true');
    const live = screen.getByText('Using Sprinkles in light and Tide in dark');
    expect(live).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(button('Use Clay in light and dark'));
    expect(live).toHaveTextContent('Using Clay in light and dark');
  });

  it('keeps selection and keyboard focus apart, even under forced colours', () => {
    renderTab();
    // Forced colours drop box-shadow rings but repaint outlines.
    const pressed = screen
      .getAllByRole('button', { name: /^Use .+ for (light|dark)$/ })
      .filter((each) => each.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(2);
    for (const each of pressed) {
      expect(each).toHaveClass('outline-primary', 'forced-colors:focus-visible:outline-offset-2');
      // Focus keeps the accent outline and rings it in the foreground colour, never over it.
      expect(each).toHaveClass(
        'focus-visible:ring-foreground',
        'focus-visible:ring-[3.5px]',
        'focus-visible:outline-offset-0',
      );
      expect(each).not.toHaveClass('focus-visible:outline-hidden');
    }
    expect(radio('Match computer')).toHaveClass('outline-transparent');
  });

  it('customizes a built-in from its ⋯ menu as a named copy', async () => {
    const store = createStore();
    store.set(themeHalvesAtom, { light: 'clay', dark: 'moss' });
    renderTab(store);
    fireEvent.keyDown(button('More for Clay'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Customize' }));
    const clay = findTheme('clay', []);
    expect(store.get(themeEditorSessionAtom)).toEqual({
      mode: 'create',
      appearance: 'light',
      seed: { id: 'clay-copy', name: 'Clay copy', light: clay.light, dark: clay.dark },
    });
  });

  it('starts a new theme from stock Frink as the stylesheet paints it', () => {
    const store = renderTab();
    expect(button('New theme')).toHaveAccessibleDescription(/^Starts from Frink\./);
    fireEvent.click(button('New theme'));
    const seed = store.get(themeEditorSessionAtom)?.seed;
    expect(seed?.name).toBe('My theme');
    expect(seed?.light).toMatchObject({ background: STOCK.light.background, accent: '#7c3aed' });
    expect(seed?.dark).toMatchObject({ background: STOCK.dark.background, accent: '#a78bfa' });
  });

  it('edits a custom theme from its ⋯ menu', async () => {
    const store = createStore();
    store.set(customThemesAtom, () => [MINE]);
    renderTab(store);
    const editing = { mode: 'edit', editingId: 'mine', seed: MINE, appearance: 'light' };

    fireEvent.keyDown(button('More for Mine'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(store.get(themeEditorSessionAtom)).toEqual(editing);
  });

  it('deletes a custom theme back to Frink, and undo restores it', async () => {
    const store = renderWithMenuOpen();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(store.get(customThemesAtom)).toEqual([]);
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'frink', dark: 'frink' });
    expect(screen.queryByRole('button', { name: 'Use Mine in light and dark' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(store.get(customThemesAtom)).toEqual([MINE]);
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'frink', dark: 'mine' });
  });

  it('restores a deleted theme under a new id when its id was taken meanwhile', async () => {
    const store = renderWithMenuOpen();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const newer = { ...MINE, name: 'Newer' };
    store.set(customThemesAtom, () => [newer]);

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(store.get(customThemesAtom)).toEqual([{ ...MINE, id: 'mine-2', name: 'Mine' }, newer]);
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'frink', dark: 'mine-2' });
  });

  it('keeps a theme picked since the delete when undo restores the deleted one', async () => {
    const store = renderWithMenuOpen();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(strip('Moss', 'dark'));

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(store.get(customThemesAtom)).toEqual([MINE]);
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'frink', dark: 'moss' });
  });

  it('refuses an undo once saved themes cannot be read, leaving the picks alone', async () => {
    const store = renderWithMenuOpen();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const key = 'preferences:custom-themes';
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key, newValue: '{', storageArea: localStorage }),
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'frink', dark: 'frink' });
    expect(
      await screen.findByText("Your saved themes couldn't be read, so “Mine” wasn't restored."),
    ).toBeInTheDocument();
  });

  it('exports a custom theme as <id>.json', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mine');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderWithMenuOpen();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export file' }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click.mock.contexts[0]).toMatchObject({ download: 'mine.json' });
  });

  it('locks theme picking, and only that, while the editor is open', () => {
    const store = createStore();
    store.set(themeEditorSessionAtom, {
      mode: 'edit',
      editingId: 'mine',
      seed: MINE,
      appearance: 'dark',
    });
    store.set(themeEditorDraftNameAtom, 'Ocean');
    renderTab(store);
    expect(screen.getByText(/You're editing “Ocean”/)).toBeInTheDocument();
    expect(button('Use Frink in light and dark').closest('[inert]')).not.toBeNull();
    expect(radio('Dark').closest('[inert]')).toBeNull();
    expect(screen.getByRole('slider', { name: 'Contrast' }).closest('[inert]')).toBeNull();
  });
});

describe('AgentsAppearanceTab mode', () => {
  it('moves the mode with arrow keys inside one tab stop', () => {
    renderTab();
    expect(screen.getByRole('radiogroup', { name: 'Light or dark' })).toBeInTheDocument();
    expect(radio('Match computer')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Match computer')).toHaveAttribute('tabindex', '0');
    expect(radio('Light')).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(radio('Match computer'), { key: 'ArrowRight' });
    expect(radio('Light')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Light')).toHaveFocus();
    expect(localStorage.getItem('theme')).toBe('light');

    fireEvent.keyDown(radio('Light'), { key: 'ArrowLeft' });
    fireEvent.keyDown(radio('Match computer'), { key: 'ArrowUp' });
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Dark')).toHaveFocus();
  });

  it('paints the pick inside the view-transition update', () => {
    stubReducedMotion(false);
    const { start, snapshots } = stubViewTransition();
    renderInThemeEffects(createStore());
    const html = document.documentElement;

    fireEvent.click(radio('Dark'));
    expect(start).toHaveBeenCalledTimes(1);
    expect(snapshots[0]).toMatchObject({ scheme: 'dark' });
    expect(snapshots[0].cls.split(' ')).toContain('dark');

    const before = html.style.getPropertyValue('--background');
    fireEvent.click(button('Use Moss in light and dark'));
    expect(start).toHaveBeenCalledTimes(2);
    expect(snapshots[1].id).toBe('moss');
    expect(snapshots[1].bg).not.toBe(before);
    expect(snapshots[1].bg).toBe(html.style.getPropertyValue('--background'));
  });

  it('steps an arrow key from the focused radio while the last pick waits to update', () => {
    stubReducedMotion(false);
    const pending = stubDeferredViewTransition();
    renderTab();

    fireEvent.keyDown(radio('Match computer'), { key: 'ArrowRight' });
    fireEvent.keyDown(radio('Light'), { key: 'ArrowRight' });
    expect(radio('Dark')).toHaveFocus();
    act(() => {
      for (const update of pending) update();
    });
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
  });

  it('ends on the last of several picks made before their view transitions update', () => {
    stubReducedMotion(false);
    const pending = stubDeferredViewTransition();
    const store = createStore();
    renderInThemeEffects(store);

    fireEvent.click(button('Use Clay in light and dark'));
    fireEvent.click(strip('Moss', 'dark'));
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'frink', dark: 'frink' });
    act(() => {
      for (const update of pending) update();
    });
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'clay', dark: 'moss' });
    expect(document.documentElement.dataset.themeId).toBe('clay');
  });

  it('picks without a view transition when motion is reduced', () => {
    stubReducedMotion(true);
    const { start } = stubViewTransition();
    renderInThemeEffects(createStore());
    fireEvent.click(button('Use Moss in light and dark'));
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.themeId).toBe('moss');
  });
});

describe('AgentsAppearanceTab fine-tune', () => {
  it('holds Standard contrast at the centre and reads positions out as percentages', () => {
    const store = renderTab();
    const slider = screen.getByRole('slider', { name: 'Contrast' });
    expect(slider).toHaveValue('50');
    expect(slider).toHaveAttribute('aria-valuetext', 'Standard');

    fireEvent.input(slider, { target: { value: '70' } });
    expect(slider).toHaveAttribute('aria-valuetext', 'Sharper · 140%');
    expect(screen.getByText('Sharper · 140%')).toBeInTheDocument();
    // The fill runs from Standard to the thumb.
    expect(slider.style.getPropertyValue('--range-from')).toBe('50%');
    expect(slider.style.getPropertyValue('--range-to')).toBe('70%');
    expect(store.get(contrastAtom)).toBe(100);
    expect(document.documentElement).toHaveClass('theme-switching');

    fireEvent.change(slider);
    expect(store.get(contrastAtom)).toBe(140);

    fireEvent.input(slider, { target: { value: '25' } });
    expect(slider).toHaveAttribute('aria-valuetext', 'Softer · 75%');
    expect(slider.style.getPropertyValue('--range-from')).toBe('25%');
  });

  it('names each transparency step', () => {
    renderTab();
    const slider = screen.getByRole('slider', { name: 'Transparency' });
    const readouts = ['Solid', 'Low', 'Standard', 'High', 'See-through'];
    for (const [index, readout] of readouts.entries()) {
      fireEvent.input(slider, { target: { value: String(index * 25) } });
      expect(slider).toHaveAttribute('aria-valuetext', readout);
    }
  });

  it('previews a drag live and releases one that ends where it started', async () => {
    const store = renderTab();
    const slider = screen.getByRole('slider', { name: 'Transparency' });
    const html = document.documentElement;
    const alpha = (level: number) => glassVars(level, 'light')['--glass-opacity'];
    fireEvent.input(slider, { target: { value: '75' } });
    await waitFor(() => expect(html.style.getPropertyValue('--glass-opacity')).toBe(alpha(75)));

    fireEvent.input(slider, { target: { value: '50' } });
    fireEvent.pointerUp(slider);
    // Released before the next frame: the value is painted at once, not left at 75.
    expect(html.style.getPropertyValue('--glass-opacity')).toBe(alpha(50));
    await waitFor(() => expect(html).not.toHaveClass('theme-switching'));
    expect(store.get(transparencyAtom)).toBe(50);
  });

  it('does not leave an uncommitted contrast preview on screen when the page closes mid-drag', async () => {
    const store = createStore();
    store.set(customThemesAtom, () => [MINE]);
    store.set(themeHalvesAtom, { light: 'mine', dark: 'mine' });
    const { closeTab } = renderInThemeEffects(store);
    const html = document.documentElement;
    const stored = hexToHslTriplet(store.get(activePaletteAtom)!.colors.text);
    expect(html.style.getPropertyValue('--foreground')).toBe(stored);

    fireEvent.input(screen.getByRole('slider', { name: 'Contrast' }), { target: { value: '70' } });
    await waitFor(() => expect(html.style.getPropertyValue('--foreground')).not.toBe(stored));

    closeTab();
    expect(store.get(contrastAtom)).toBe(100);
    expect(html.style.getPropertyValue('--foreground')).toBe(
      hexToHslTriplet(store.get(activePaletteAtom)!.colors.text),
    );
  });

  it('does not leave an uncommitted transparency preview on screen when the page closes mid-drag', async () => {
    const store = createStore();
    const { closeTab } = renderInThemeEffects(store);
    const html = document.documentElement;
    const stored = glassVars(50, 'light')['--glass-opacity'];
    expect(html.style.getPropertyValue('--glass-opacity')).toBe(stored);

    fireEvent.input(screen.getByRole('slider', { name: 'Transparency' }), {
      target: { value: '75' },
    });
    await waitFor(() => expect(html.style.getPropertyValue('--glass-opacity')).not.toBe(stored));

    closeTab();
    expect(store.get(transparencyAtom)).toBe(50);
    expect(html.style.getPropertyValue('--glass-opacity')).toBe(stored);
  });

  it('leaves <html> to the theme editor when its preview starts before a dragged frame paints', async () => {
    const store = createStore();
    renderTab(store);
    const html = document.documentElement;
    fireEvent.input(screen.getByRole('slider', { name: 'Contrast' }), { target: { value: '70' } });
    fireEvent.input(screen.getByRole('slider', { name: 'Transparency' }), {
      target: { value: '75' },
    });

    act(() => store.set(previewActiveAtom, true));
    // Stand-ins for the draft the editor has painted.
    html.style.setProperty('--foreground', 'draft');
    html.style.setProperty('--glass-opacity', 'draft');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(html.style.getPropertyValue('--foreground')).toBe('draft');
    expect(html.style.getPropertyValue('--glass-opacity')).toBe('draft');
  });

  it('drops a transparency drag cut short when the OS turns panels solid', () => {
    const setSolid = stubSolidPanels();
    const store = renderTab();
    const slider = screen.getByRole('slider', { name: 'Transparency' });
    fireEvent.input(slider, { target: { value: '75' } });
    expect(slider).toHaveAttribute('aria-valuetext', 'High');

    act(() => setSolid(true));
    expect(slider).toBeDisabled();
    act(() => setSolid(false));
    expect(slider).toHaveValue('50');
    expect(slider).toHaveAttribute('aria-valuetext', 'Standard');
    expect(document.documentElement.style.getPropertyValue('--glass-opacity')).toBe(
      glassVars(50, 'light')['--glass-opacity'],
    );
    expect(store.get(transparencyAtom)).toBe(50);
  });

  it('resets contrast and transparency together, offered only off their defaults', () => {
    const store = createStore();
    store.set(contrastAtom, 140);
    store.set(transparencyAtom, 75);
    renderTab(store);
    expect(screen.getByRole('slider', { name: 'Contrast' })).toHaveValue('70');
    expect(screen.getByText('High')).toBeInTheDocument();

    fireEvent.click(button('Reset both'));
    expect(store.get(contrastAtom)).toBe(100);
    expect(store.get(transparencyAtom)).toBe(50);
    expect(screen.queryByRole('button', { name: 'Reset both' })).toBeNull();
  });
});
