// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { derivePalette } from './derive';
import type { ThemeDefinition } from './theme-schema';

const KEY = 'preferences:custom-themes';
const THEME: ThemeDefinition = {
  id: 'my-theme',
  name: 'My theme',
  light: { background: '#ffffff', accent: '#0034ff', syntax: 'github-light' },
  dark: { background: '#050505', accent: '#a78bfa', syntax: 'github-dark' },
};

// Storage is read when the module creates its atoms, so each case imports a fresh copy.
async function load(stored: string | null) {
  localStorage.clear();
  if (stored !== null) localStorage.setItem(KEY, stored);
  vi.resetModules();
  return { ...(await import('./theme-atoms')), store: createStore() };
}

describe('customThemesAtom', () => {
  it('stores themes as a JSON array', async () => {
    const { customThemesAtom, store } = await load(null);
    expect(store.set(customThemesAtom, () => [THEME])).toBe(true);
    expect(store.set(customThemesAtom, (themes) => [...themes, { ...THEME, id: 'second' }])).toBe(
      true,
    );
    expect(JSON.parse(localStorage.getItem(KEY) ?? '')).toEqual([
      THEME,
      { ...THEME, id: 'second' },
    ]);
  });

  it('refuses writes over stored themes it could not decode', async () => {
    const { customThemesAtom, customThemesUnavailableAtom, store } = await load('[{"broken"');
    expect(store.get(customThemesUnavailableAtom)).toBe(true);
    expect(store.get(customThemesAtom)).toEqual([]);
    expect(store.set(customThemesAtom, () => [THEME])).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('[{"broken"');
  });

  it('follows writes from another window', async () => {
    const { customThemesAtom, store } = await load(null);
    const unsubscribe = store.sub(customThemesAtom, () => {});
    const newValue = JSON.stringify([THEME]);
    localStorage.setItem(KEY, newValue);
    window.dispatchEvent(
      new StorageEvent('storage', { key: KEY, newValue, storageArea: localStorage }),
    );
    expect(store.get(customThemesAtom)).toEqual([THEME]);
    unsubscribe();
  });
});

describe('contrastAtom and transparencyAtom', () => {
  it('read a corrupt or out-of-range stored value back inside their scale', async () => {
    const { contrastAtom, transparencyAtom, store } = await load(null);
    localStorage.setItem('preferences:appearance-contrast', '"x"');
    localStorage.setItem('preferences:appearance-transparency', '400');
    vi.resetModules();
    const fresh = await import('./theme-atoms');

    expect(store.get(fresh.contrastAtom)).toBe(100);
    expect(store.get(fresh.transparencyAtom)).toBe(100);
    store.set(contrastAtom, 120);
    store.set(transparencyAtom, 25);
    expect(store.get(contrastAtom)).toBe(120);
    expect(store.get(transparencyAtom)).toBe(25);
  });

  it('keeps contrast inside 50–200, defaulting to 100', async () => {
    const { contrastAtom, store } = await load(null);
    expect(store.get(contrastAtom)).toBe(100);
    store.set(contrastAtom, 50);
    expect(store.get(contrastAtom)).toBe(50);
    store.set(contrastAtom, 200);
    expect(store.get(contrastAtom)).toBe(200);
    store.set(contrastAtom, 30);
    expect(store.get(contrastAtom)).toBe(50);
    store.set(contrastAtom, 260);
    expect(store.get(contrastAtom)).toBe(200);
  });
});

describe('codeThemeAtom', () => {
  it("follows the committed palette's syntax, github-dark before boot", async () => {
    const { activePaletteAtom, codeThemeAtom, store } = await load(null);
    expect(store.get(codeThemeAtom)).toBe('github-dark');

    store.set(activePaletteAtom, {
      themeId: 'tide',
      appearance: 'dark',
      syntax: 'min-dark',
      colors: derivePalette({ background: '#1f1f1f', accent: '#6ca1ef' }),
      stock: false,
      inline: true,
    });
    expect(store.get(codeThemeAtom)).toBe('min-dark');
  });
});
