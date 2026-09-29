// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { ThemeProvider } from 'next-themes';
import { toast, Toaster } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarMainPaneLayout } from '@/components/SidebarMainPaneLayout';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  activeOverlayAtom,
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
} from '@/lib/atoms';
import { closesEditorOnEscape } from '@/lib/code-editor/state';
import {
  type ThemeEditorSession,
  themeEditorDraftNameAtom,
  themeEditorSelectedRoleAtom,
  themeEditorSessionAtom,
} from '@/lib/themes/editor/editor-atoms';
import { paintedPalette } from '@/lib/themes/palette/apply';
import { hexToHslTriplet } from '@/lib/themes/palette/color';
import { derivePalette } from '@/lib/themes/palette/derive';
import {
  activePaletteAtom,
  customThemesAtom,
  previewActiveAtom,
  themeHalvesAtom,
} from '@/lib/themes/palette/theme-atoms';
import type { Half, ThemeDefinition } from '@/lib/themes/palette/theme-schema';
import { installStockSheet } from '@/lib/themes/stock-sheet-fixture';
import { ThemeEditorHost } from '.';

// Closing the editor repaints the stored theme, which reads stock Frink from globals.css.
installStockSheet();

// happy-dom has no checkVisibility (Inspect's usage count) or Web Animations (the dock's glide
// and the spotlight's fade).
Element.prototype.checkVisibility = () => true;
Object.defineProperty(Element.prototype, 'animate', {
  value: () => ({ reverse() {}, cancel() {} }),
});

// Loads the lazy panel up front, so no test's wait is spent transforming it.
beforeAll(() => import('./Panel'));

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
});

const SEED: ThemeDefinition = {
  id: 'my-theme',
  name: 'My theme',
  light: { background: '#faf9f5', accent: '#b05230', syntax: 'github-light' },
  dark: { background: '#262624', accent: '#d97857', syntax: 'github-dark' },
};
const CREATE: ThemeEditorSession = { mode: 'create', seed: SEED, appearance: 'dark' };
const STORED: ThemeDefinition = {
  ...SEED,
  id: 'stored',
  name: 'Stored',
  light: { background: '#fdf6e3', accent: '#268bd2', syntax: 'github-light' },
};

function renderEditor(
  session: ThemeEditorSession,
  themes: ThemeDefinition[] = [],
  defaultTheme = 'light',
) {
  const store = createStore();
  store.set(customThemesAtom, () => themes);
  store.set(themeEditorSessionAtom, session);
  render(
    <Provider store={store}>
      <ThemeProvider attribute="class" defaultTheme={defaultTheme}>
        <TooltipProvider>
          <ThemeEditorHost />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </Provider>,
  );
  return store;
}

function changeSchemeInAnotherWindow(scheme: string) {
  act(() => {
    localStorage.setItem('theme', scheme);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'theme', newValue: scheme, storageArea: localStorage }),
    );
  });
}

function saveInAnotherWindow(themes: ThemeDefinition[]) {
  const value = JSON.stringify(themes);
  localStorage.setItem('preferences:custom-themes', value);
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'preferences:custom-themes',
      newValue: value,
      storageArea: localStorage,
    }),
  );
}

function stubSystemDark() {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    Object.defineProperty(matchMedia(query), 'matches', {
      value: query === '(prefers-color-scheme: dark)',
    }),
  );
}

/** Asserts <html> and the committed palette are on the light half of stored theme `themeId`. */
function expectStoredLight(store: ReturnType<typeof createStore>, themeId: string, light: Half) {
  const html = document.documentElement;
  expect(html.style.getPropertyValue('--background')).toBe(
    hexToHslTriplet(derivePalette(light).background),
  );
  expect(html).toHaveClass('light');
  expect(html).not.toHaveClass('dark');
  expect(store.get(activePaletteAtom)?.themeId).toBe(themeId);
  expect(paintedPalette()).toBe(store.get(activePaletteAtom));
}

/** An app element whose background paints from --border (happy-dom computes no colours). */
function borderSwatch(): HTMLElement {
  const swatch = document.body.appendChild(document.createElement('div'));
  vi.spyOn(swatch, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 40, 20));
  const computeStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = computeStyle(element);
    if (element !== swatch) return style;
    const border = document.documentElement.style.getPropertyValue('--border');
    style.getPropertyValue = (property) => (property === 'background-color' ? border : '');
    return style;
  });
  return swatch;
}

const button = (name: string) => screen.getByRole('button', { name });
const allColors = () => screen.getByRole('button', { name: /^All colors/ });
const picker = () => document.querySelector('[data-popover="true"]');
const pressEscape = () =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('ThemeEditorHost', () => {
  it('previews the edited half live and creates the theme on save', async () => {
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary', { name: 'New theme' });
    expect(store.get(previewActiveAtom)).toBe(true);
    const html = document.documentElement;
    await waitFor(() =>
      expect(html.style.getPropertyValue('--background')).toBe(
        hexToHslTriplet(derivePalette(SEED.dark).background),
      ),
    );
    expect(html).toHaveClass('dark');
    // Terminal, Monaco and Shiki get the draft once it settles.
    await waitFor(() => expect(store.get(activePaletteAtom)?.themeId).toBe('my-theme'));

    type('Theme name', 'Ember');
    type('Accent hex value', '#FF5500');
    fireEvent.click(button('Create theme'));

    expect(store.get(customThemesAtom)).toEqual([
      { ...SEED, id: 'ember', name: 'Ember', dark: { ...SEED.dark, accent: '#ff5500' } },
    ]);
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'ember', dark: 'ember' });
    expect(store.get(themeEditorSessionAtom)).toBeNull();
    expect(store.get(previewActiveAtom)).toBe(false);
    expectStoredLight(store, 'ember', SEED.light);
    expect(await screen.findByText('“Ember” is on.')).toBeInTheDocument();
  });

  it('saves an edit in place under the same id', async () => {
    const other = { ...SEED, id: 'other', name: 'Other' };
    const mine = { ...SEED, id: 'mine', name: 'Mine' };
    const store = renderEditor(
      { mode: 'edit', editingId: 'mine', seed: mine, appearance: 'light' },
      [mine, other],
    );
    await screen.findByRole('complementary', { name: 'Edit theme' });
    type('Background hex value', '#fdf6e3');
    fireEvent.click(button('Save changes'));

    expect(store.get(customThemesAtom)).toEqual([
      { ...mine, light: { ...mine.light, background: '#fdf6e3' } },
      other,
    ]);
  });

  it('never overwrites a theme another window saved since the last render', async () => {
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    type('Theme name', 'Ember');
    // Outside act, so the panel has not re-rendered with the other window's theme when Create runs.
    saveInAnotherWindow([{ ...SEED, id: 'ember', name: 'Ember' }]);
    fireEvent.click(button('Create theme'));

    expect(store.get(customThemesAtom).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'ember', name: 'Ember' },
      { id: 'ember-2', name: 'Ember 2' },
    ]);
  });

  it('numbers a blank name past the ones already taken', async () => {
    const store = renderEditor({ ...CREATE, seed: { ...SEED, name: '' } }, [SEED]);
    await screen.findByRole('complementary');
    expect(screen.getByLabelText('Theme name')).toHaveAttribute('placeholder', 'My theme 2');
    fireEvent.click(button('Create theme'));
    expect(store.get(customThemesAtom)[1]).toMatchObject({ id: 'my-theme-2', name: 'My theme 2' });
  });

  it('closes at once when nothing changed, and confirms before discarding changes', async () => {
    let store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    fireEvent.click(button('Cancel'));
    expect(store.get(themeEditorSessionAtom)).toBeNull();
    cleanup();

    store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    type('Theme name', 'Ember');
    expect(store.get(themeEditorDraftNameAtom)).toBe('Ember');
    fireEvent.click(button('Cancel'));
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard changes to “Ember”?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(store.get(themeEditorSessionAtom)).not.toBeNull();

    fireEvent.click(button('Close theme editor'));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(store.get(themeEditorSessionAtom)).toBeNull();
    expect(store.get(customThemesAtom)).toEqual([]);
  });

  it('hands <html> and the committed palette back to the stored theme on close', async () => {
    const store = renderEditor(CREATE, [STORED]);
    act(() => store.set(themeHalvesAtom, { light: 'stored', dark: 'stored' }));
    await screen.findByRole('complementary');
    await waitFor(() => expect(store.get(activePaletteAtom)?.themeId).toBe('my-theme'));
    fireEvent.click(button('Cancel'));
    expect(store.get(themeEditorSessionAtom)).toBeNull();
    expect(store.get(previewActiveAtom)).toBe(false);
    expectStoredLight(store, 'stored', STORED.light);
  });

  it('pins a role from All colors and resets it to the derived colour', async () => {
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    fireEvent.click(allColors());
    await screen.findByLabelText('Text hex value');

    type('Text hex value', '#123456');
    expect(screen.getByLabelText('Text hex value')).toHaveValue('#123456');
    fireEvent.click(button('Reset Text'));
    expect(screen.queryByRole('button', { name: 'Reset Text' })).not.toBeInTheDocument();
    type('Faded text hex value', '#654321');

    fireEvent.click(button('Create theme'));
    expect(store.get(customThemesAtom)[0]?.dark.overrides).toEqual({ mutedText: '#654321' });
  });

  it("treats a copy's inherited colours as Frink's picks and lists each seed once", async () => {
    const copy = { ...SEED, dark: { ...SEED.dark, overrides: { text: '#eeeeee' } } };
    const store = renderEditor({ ...CREATE, seed: copy });
    await screen.findByRole('complementary');
    fireEvent.click(allColors());
    await screen.findByLabelText('Text hex value');
    expect(screen.queryByRole('button', { name: 'Reset Text' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Choose Accent color' })).toHaveLength(1);
    expect(screen.queryByLabelText('Window hex value')).not.toBeInTheDocument();

    type('Accent hex value', 'ffe066');
    fireEvent.click(button('Create theme'));
    expect(store.get(customThemesAtom)[0]?.dark).toEqual({
      ...SEED.dark,
      accent: '#ffe066',
      overrides: {},
    });
  });

  it('switches the edited side from its strip and undoes every change', async () => {
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    expect(button('Dark · editing')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Undo my changes')).toBeDisabled();

    type('Accent hex value', '#ff5500');
    fireEvent.blur(screen.getByLabelText('Accent hex value'));
    fireEvent.click(button('Light'));
    expect(button('Light · editing')).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement).toHaveClass('light');
    expect(screen.getByLabelText('Accent hex value')).toHaveValue(SEED.light.accent);
    type('Theme name', 'Ember');

    fireEvent.click(button('Undo my changes'));
    expect(screen.getByLabelText('Theme name')).toHaveValue(SEED.name);
    expect(store.get(themeEditorDraftNameAtom)).toBe(SEED.name);
    fireEvent.click(button('Dark'));
    expect(screen.getByLabelText('Accent hex value')).toHaveValue(SEED.dark.accent);
    fireEvent.click(button('Cancel'));
    expect(store.get(themeEditorSessionAtom)).toBeNull();
  });

  it('counts changed colours and marks only text that is hard to read', async () => {
    renderEditor(CREATE);
    await screen.findByRole('complementary');
    fireEvent.click(allColors());
    expect(screen.queryByText('Hard to read')).not.toBeInTheDocument();

    type('Faded text hex value', '#3f3f3d');
    type('Borders hex value', '#262624');
    expect(allColors()).toHaveAccessibleName('All colors · 2 changed');
    const warning = screen.getByText('Hard to read');
    expect(warning.closest('[data-theme-role]')).toHaveAttribute('data-theme-role', 'mutedText');
    expect(screen.getAllByTitle('Changed by you')).toHaveLength(2);
  });

  it('spotlights a hovered row once the pointer settles and counts its places', async () => {
    renderEditor(CREATE);
    await screen.findByRole('complementary');
    const swatch = borderSwatch();
    fireEvent.click(allColors());
    const row = screen
      .getByLabelText('Borders hex value')
      .closest<HTMLElement>('[data-theme-role]');
    if (!row) throw new Error('Borders row is missing');

    fireEvent.pointerEnter(row);
    expect(await within(row).findByText('1 place')).toBeInTheDocument();
    fireEvent.pointerLeave(row);
    await waitFor(() => expect(within(row).queryByText('1 place')).toBeNull());

    swatch.remove();
    fireEvent.pointerEnter(row);
    expect(await within(row).findByText('Not on screen')).toBeInTheDocument();
  });

  it('lets go of a hovered row that a filter removes from under the pointer', async () => {
    const store = renderEditor(CREATE);
    const panel = await screen.findByRole('complementary');
    const swatch = borderSwatch();
    act(() => store.set(themeEditorSelectedRoleAtom, 'border'));
    const status = within(panel).getByRole('status');
    const selected = 'Borders · Shown in 1 place on screen';
    await waitFor(() => expect(status).toHaveTextContent(selected));

    const faded = screen.getByLabelText('Faded text hex value').closest('[data-theme-role]');
    if (!faded) throw new Error('Faded text row is missing');
    fireEvent.pointerEnter(faded);
    await waitFor(() => expect(status).toBeEmptyDOMElement());
    // The row unmounts without a pointerleave, as it does under a resting pointer.
    type('Filter colors', 'borders');
    expect(faded).not.toBeInTheDocument();
    await waitFor(() => expect(status).toHaveTextContent(selected));
    swatch.remove();
  });

  it('closed beside an inset main pane, takes back the row gap; open, keeps it', async () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <ThemeProvider attribute="class" defaultTheme="light">
          <TooltipProvider>
            <SidebarMainPaneLayout inset dock={<ThemeEditorHost />}>
              <section />
            </SidebarMainPaneLayout>
          </TooltipProvider>
        </ThemeProvider>
      </Provider>,
    );
    const dock = document.querySelector('[data-theme-editor-dock]');
    expect(dock).toHaveClass('w-0', '-ml-1');

    act(() => store.set(themeEditorSessionAtom, CREATE));
    await screen.findByRole('complementary');
    expect(dock).toHaveClass('w-93');
    expect(dock).not.toHaveClass('-ml-1');
  });

  it('docks at full width only while a session is open', async () => {
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    const dock = document.querySelector('[data-theme-editor-dock]');
    expect(dock).toHaveClass('w-93');
    fireEvent.click(button('Cancel'));
    expect(store.get(themeEditorSessionAtom)).toBeNull();
    expect(dock).toHaveClass('w-0');
    expect(dock).toBeEmptyDOMElement();
  });

  it('explains an invalid hex value until it becomes one', async () => {
    renderEditor(CREATE);
    await screen.findByRole('complementary');
    const field = screen.getByLabelText('Accent hex value');
    fireEvent.focus(field);
    type('Accent hex value', '#12');
    expect(field).toHaveAccessibleDescription('Use a color like #1a2b3c');
    type('Accent hex value', '#123456');
    expect(screen.queryByText('Use a color like #1a2b3c')).not.toBeInTheDocument();
  });

  it('focuses the name on open and hands focus back on close', async () => {
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    expect(screen.getByLabelText('Theme name')).toHaveFocus();
    fireEvent.click(button('Cancel'));
    expect(store.get(themeEditorSessionAtom)).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  it('hands focus to the chat composer on close when the opener is gone', async () => {
    const opener = document.body.appendChild(document.createElement('button'));
    const composer = document.body.appendChild(document.createElement('div'));
    composer.tabIndex = 0;
    composer.dataset.chatInput = 'true';
    opener.focus();
    renderEditor(CREATE);
    await screen.findByRole('complementary');
    opener.remove();
    fireEvent.click(button('Cancel'));
    await waitFor(() => expect(composer).toHaveFocus());
    composer.remove();
  });

  it('reveals, keeps and highlights the role Inspect selects, even through a filter', async () => {
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    act(() => store.set(themeEditorSelectedRoleAtom, 'border'));
    expect(allColors()).toHaveAttribute('aria-expanded', 'true');
    const row = (await screen.findByLabelText('Borders hex value')).closest('[data-theme-role]');
    expect(row).toHaveAttribute('data-theme-role', 'border');
    expect(row).toHaveClass('ring-1');

    type('Filter colors', 'faded');
    expect(screen.getByLabelText('Faded text hex value')).toBeInTheDocument();
    expect(screen.getByLabelText('Borders hex value')).toBeInTheDocument();
    expect(screen.queryByLabelText('Window hex value')).not.toBeInTheDocument();
  });

  it('arms Inspect, swallows the pick and spotlights the role until Esc', async () => {
    renderEditor(CREATE);
    const dialog = await screen.findByRole('complementary', { name: 'New theme' });
    const swatch = borderSwatch();
    const onAppClick = vi.fn();
    swatch.addEventListener('click', onAppClick);

    fireEvent.click(button('Pick from screen'));
    expect(button('Pick from screen')).toHaveAttribute('aria-pressed', 'true');
    const status = within(dialog).getByRole('status');
    expect(status).toHaveTextContent('Click anything in Frink · Esc to stop');

    fireEvent.pointerDown(swatch);
    fireEvent.click(swatch, { detail: 1 });
    expect(onAppClick).not.toHaveBeenCalled();
    expect(button('Pick from screen')).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByLabelText('Borders hex value')).toBeInTheDocument();
    expect(status).toHaveTextContent('Borders · Shown in 1 place on screen');

    fireEvent.keyDown(screen.getByLabelText('Theme name'), { key: 'Escape' });
    expect(status).toBeEmptyDOMElement();
    swatch.remove();
  });

  it('says the terminal cannot be inspected and stops on Esc anywhere', async () => {
    renderEditor(CREATE);
    const dialog = await screen.findByRole('complementary');
    const terminal = document.body.appendChild(document.createElement('div'));
    terminal.className = 'xterm';

    fireEvent.click(button('Pick from screen'));
    fireEvent.pointerDown(terminal);
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      "The terminal and code editor can't be inspected.",
    );
    expect(button('Pick from screen')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(button('Pick from screen')).toHaveAttribute('aria-pressed', 'false');
    terminal.remove();
  });

  it('keeps Escape inside the panel and never closes it', async () => {
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    const onKeyDown = vi.fn();
    document.addEventListener('keydown', onKeyDown);
    fireEvent.keyDown(screen.getByLabelText('Theme name'), { key: 'Escape' });
    document.removeEventListener('keydown', onKeyDown);

    expect(onKeyDown).not.toHaveBeenCalled();
    expect(store.get(themeEditorSessionAtom)).not.toBeNull();
  });

  it('lets Esc close an open picker without closing an open code editor', async () => {
    renderEditor(CREATE);
    await screen.findByRole('complementary');
    // Listening before the picker opens, as an already open code editor does, so it hears Esc first.
    const closeCodeEditor = vi.fn();
    const codeEditorKeyDown = (event: KeyboardEvent) => {
      if (closesEditorOnEscape(event)) closeCodeEditor();
    };
    document.addEventListener('keydown', codeEditorKeyDown, true);
    fireEvent.click(button('Choose Accent color'));
    expect(picker()).toBeInTheDocument();

    pressEscape();
    expect(picker()).not.toBeInTheDocument();
    expect(closeCodeEditor).not.toHaveBeenCalled();
    pressEscape();
    document.removeEventListener('keydown', codeEditorKeyDown, true);
    expect(closeCodeEditor).toHaveBeenCalledOnce();
  });

  it('closes an open picker when Settings opens over the editor', async () => {
    const store = renderEditor(CREATE);
    await screen.findByRole('complementary');
    fireEvent.click(button('Choose Accent color'));
    expect(picker()).toBeInTheDocument();

    act(() => store.set(agentsSettingsDialogOpenAtom, true));
    expect(picker()).not.toBeInTheDocument();
    act(() => store.set(agentsSettingsDialogOpenAtom, false));
    expect(picker()).not.toBeInTheDocument();
  });

  it('keeps the empty status line in place and in the accessibility tree', async () => {
    renderEditor(CREATE);
    const status = within(await screen.findByRole('complementary')).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    // happy-dom applies no Tailwind: empty, the line still holds one line of text's height.
    expect(status).toHaveClass('box-content', 'min-h-4');
  });

  it('opens its picker in the theme colours and pauses behind Settings › Appearance', async () => {
    const store = renderEditor(CREATE, [STORED]);
    act(() => store.set(themeHalvesAtom, { light: 'stored', dark: 'stored' }));
    await screen.findByRole('complementary');
    type('Theme name', 'Ember');
    fireEvent.click(button('Choose Accent color'));
    const picker = document.querySelector('[data-popover="true"]');
    expect(picker).toHaveAttribute('data-theme-editor-panel');
    expect(picker).not.toHaveClass('dark');

    fireEvent.click(button('Appearance'));
    expect(store.get(activeOverlayAtom)).toBe('settings');
    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('appearance');
    expect(screen.queryByRole('complementary', { name: 'New theme' })).not.toBeInTheDocument();
    // Settings' own chrome shows the stored theme while the draft waits behind it.
    expect(store.get(previewActiveAtom)).toBe(false);
    expectStoredLight(store, 'stored', STORED.light);

    act(() => store.set(activeOverlayAtom, null));
    expect(store.get(previewActiveAtom)).toBe(true);
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(
      hexToHslTriplet(derivePalette(SEED.dark).background),
    );
    expect(screen.getByLabelText('Theme name')).toHaveValue('Ember');
  });

  it.each([
    { stored: 'light', setup: () => {} },
    { stored: 'system', setup: stubSystemDark },
  ])(
    'keeps the light draft class when another window switches from $stored to Dark',
    async ({ stored, setup }) => {
      setup();
      const store = renderEditor({ ...CREATE, appearance: 'light' }, [], stored);
      await screen.findByRole('complementary');
      const html = document.documentElement;

      changeSchemeInAnotherWindow('dark');
      await waitFor(() => {
        expect(html).toHaveClass('light');
        expect(html).not.toHaveClass('dark');
      });

      fireEvent.click(button('Cancel'));
      expect(store.get(themeEditorSessionAtom)).toBeNull();
      expect(html).toHaveClass('dark');
      expect(html).not.toHaveClass('light');
    },
  );
});
