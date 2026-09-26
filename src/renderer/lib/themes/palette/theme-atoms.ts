import * as Sentry from '@sentry/electron/renderer';
import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { ActivePalette } from './apply';
import { FRINK_THEME_ID } from './built-in-themes';
import { CONTRAST_RANGE } from './contrast';
import { TRANSPARENCY_SCALE } from './glass';
import type { ThemeHalves } from './resolve';
import {
  type CustomThemeLibrary,
  DEFAULT_SYNTAX,
  parseStoredThemes,
  type ThemeDefinition,
} from './theme-schema';

export const themeHalvesAtom = atomWithStorage<ThemeHalves>(
  'preferences:theme-halves',
  { light: FRINK_THEME_ID, dark: FRINK_THEME_ID },
  undefined,
  { getOnInit: true },
);

type Scale = { min: number; max: number; default: number };

/** A stored slider value, read back finite and inside its scale whatever storage holds. */
function scaleAtom(key: string, scale: Scale) {
  const stored = atomWithStorage<number>(key, scale.default, undefined, { getOnInit: true });
  return atom(
    (get) => {
      const value = get(stored);
      return Number.isFinite(value)
        ? Math.min(scale.max, Math.max(scale.min, value))
        : scale.default;
    },
    (_get, set, value: number) => set(stored, value),
  );
}

export const contrastAtom = scaleAtom('preferences:appearance-contrast', CONTRAST_RANGE);

export const transparencyAtom = scaleAtom(
  'preferences:appearance-transparency',
  TRANSPARENCY_SCALE,
);

function decodeCustomThemes(raw: string | null): CustomThemeLibrary {
  const library = parseStoredThemes(raw);
  if (library.status === 'unavailable') {
    Sentry.captureException(new Error('Stored custom themes failed to decode'), {
      tags: { surface: 'custom-themes-storage' },
    });
  }
  return library;
}

/** Decodes at the storage boundary and syncs other windows, like jotai's JSON storage. */
const customThemeStorage = {
  getItem: (key: string): CustomThemeLibrary => decodeCustomThemes(localStorage.getItem(key)),
  setItem: (key: string, library: CustomThemeLibrary): void => {
    if (library.status === 'ready') localStorage.setItem(key, JSON.stringify(library.themes));
  },
  removeItem: (key: string): void => localStorage.removeItem(key),
  subscribe: (key: string, callback: (library: CustomThemeLibrary) => void): (() => void) => {
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea === localStorage && event.key === key)
        callback(decodeCustomThemes(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  },
};

const customThemeLibraryAtom = atomWithStorage<CustomThemeLibrary>(
  'preferences:custom-themes',
  { status: 'ready', themes: [] },
  customThemeStorage,
  { getOnInit: true },
);

/** True when stored themes could not be read; the page says so and every write is refused. */
export const customThemesUnavailableAtom = atom(
  (get) => get(customThemeLibraryAtom).status === 'unavailable',
);

const NO_THEMES: ThemeDefinition[] = [];

/**
 * The user's themes, written with an updater. A write returns false and stores nothing while the
 * library is unavailable.
 */
export const customThemesAtom = atom(
  (get) => {
    const library = get(customThemeLibraryAtom);
    return library.status === 'ready' ? library.themes : NO_THEMES;
  },
  (get, set, update: (themes: ThemeDefinition[]) => ThemeDefinition[]): boolean => {
    const library = get(customThemeLibraryAtom);
    if (library.status === 'unavailable') return false;
    set(customThemeLibraryAtom, { status: 'ready', themes: update(library.themes) });
    return true;
  },
);

/** The committed palette consumers (terminal, Monaco, Shiki) read; null until first applied. */
export const activePaletteAtom = atom<ActivePalette | null>(null);

/** The committed Shiki theme; a string, so code blocks re-render only when it changes. */
export const codeThemeAtom = atom((get) => get(activePaletteAtom)?.syntax ?? DEFAULT_SYNTAX.dark);

/** True while the theme editor's live preview owns <html>; ThemeEffects stands down. */
export const previewActiveAtom = atom(false);
