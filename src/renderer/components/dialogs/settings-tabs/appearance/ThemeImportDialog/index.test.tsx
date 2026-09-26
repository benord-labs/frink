// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_THEME_FILE_BYTES } from '@/lib/themes/import/import-themes';
import { customThemesAtom, themeHalvesAtom } from '@/lib/themes/palette/theme-atoms';
import { serializeThemeFile, type ThemeDefinition } from '@/lib/themes/palette/theme-schema';
import { ThemeImportDialog } from '.';

const MINE: ThemeDefinition = {
  id: 'mine',
  name: 'Mine',
  light: { background: '#fff7fa', accent: '#bc2b72', syntax: 'github-light' },
  dark: { background: '#1c1519', accent: '#ff8cc6', syntax: 'github-dark' },
};
const EDITED = { ...MINE, light: { ...MINE.light, accent: '#1e754f' } };

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderDialog(saved: ThemeDefinition[] = []) {
  const store = createStore();
  store.set(customThemesAtom, () => saved);
  const onOpenChange = vi.fn();
  render(
    <Provider store={store}>
      <ThemeImportDialog open onOpenChange={onOpenChange} />
      <Toaster />
    </Provider>,
  );
  return { store, onOpenChange };
}

function paste(text: string) {
  fireEvent.change(screen.getByLabelText('Or paste a theme'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
}

describe('ThemeImportDialog', () => {
  it('saves a pasted theme file without switching to it, then closes', async () => {
    const { store, onOpenChange } = renderDialog();
    paste(serializeThemeFile(MINE));
    expect(await screen.findByText('Imported “Mine”.')).toBeInTheDocument();
    expect(store.get(customThemesAtom)).toEqual([MINE]);
    expect(store.get(themeHalvesAtom)).toEqual({ light: 'frink', dark: 'frink' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps both when the theme is already saved', async () => {
    const { store } = renderDialog([MINE]);
    paste(serializeThemeFile(EDITED));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You already have “Mine”. Keep both, or replace it?',
    );
    expect(screen.getByRole('button', { name: 'Keep both' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep both' }));
    expect(await screen.findByText('Imported “Mine 2”.')).toBeInTheDocument();
    expect(store.get(customThemesAtom)).toEqual([
      MINE,
      { ...EDITED, id: 'mine-2', name: 'Mine 2' },
    ]);
  });

  it('keeps a theme another window saved while the import was reading', async () => {
    const { store } = renderDialog();
    const OTHER = { ...MINE, id: 'other', name: 'Other' };
    paste(serializeThemeFile(MINE));
    store.set(customThemesAtom, (themes) => [...themes, OTHER]);
    expect(await screen.findByText('Imported “Mine”.')).toBeInTheDocument();
    expect(store.get(customThemesAtom)).toEqual([OTHER, MINE]);
  });

  it('replaces the saved theme when asked', async () => {
    const { store } = renderDialog([MINE]);
    paste(serializeThemeFile(EDITED));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    expect(await screen.findByText('Imported “Mine”.')).toBeInTheDocument();
    expect(store.get(customThemesAtom)).toEqual([EDITED]);
  });

  it('explains unreadable text and keeps it for fixing', async () => {
    const { onOpenChange } = renderDialog();
    paste('hello');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "The pasted text isn't a theme we can read.",
    );
    expect(screen.getByLabelText('Or paste a theme')).toHaveValue('hello');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('imports the files it can and refuses oversized ones', async () => {
    const { store, onOpenChange } = renderDialog();
    const files = [
      new File(['x'.repeat(MAX_THEME_FILE_BYTES + 1)], 'huge.json'),
      new File([serializeThemeFile(MINE)], 'mine.json'),
    ];
    fireEvent.change(screen.getByLabelText('Theme files'), { target: { files } });
    expect(await screen.findByText('Imported “Mine”.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      '“huge.json” is too big to be a theme. Theme files are only a few KB.',
    );
    expect(store.get(customThemesAtom)).toEqual([MINE]);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('imports files dropped anywhere on the dialog, header included', async () => {
    const { store } = renderDialog();
    const files = [new File([serializeThemeFile(MINE)], 'mine.json')];
    const dataTransfer = { types: ['Files'], files };
    const title = screen.getByText('Import theme');
    expect(fireEvent.dragOver(title, { dataTransfer })).toBe(false);
    expect(fireEvent.drop(title, { dataTransfer })).toBe(false);
    expect(await screen.findByText('Imported “Mine”.')).toBeInTheDocument();
    expect(store.get(customThemesAtom)).toEqual([MINE]);
  });
});
