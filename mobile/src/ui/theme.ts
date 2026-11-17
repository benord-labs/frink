import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  AccessibilityInfo,
  Appearance,
  Platform,
  useColorScheme,
  type TextStyle,
} from 'react-native';
import {
  readAppearance,
  saveAppearance,
  readTransparency,
  saveTransparency,
  type AppearanceMode,
  type Transparency,
} from '../lib/preferences';

// Neutral surfaces mirror desktop; the mobile accent uses a quieter violet.
// Colour is spent on state only: running (primary), live (green), needs you (amber), failed (red).
export const themes = {
  dark: {
    background: '#050505',
    surface: 'rgba(10,10,10,0.70)',
    card: '#0A0A0A',
    popover: '#1A1A1A',
    field: '#1A1A1A',
    fill: 'rgba(255,255,255,0.06)',
    pressed: 'rgba(255,255,255,0.08)',
    solidSurface: '#0A0A0A',
    solidCard: '#111111',
    solidField: '#1A1A1A',
    rim: 'rgba(255,255,255,0.19)',
    sheen: 'rgba(255,255,255,0.05)',
    glint: 'rgba(182,167,205,0.13)',
    glow: 'rgba(182,167,205,0.06)',
    floor: 'rgba(125,240,168,0.03)',
    text: '#E8E8E8',
    secondary: '#B8B8B8',
    muted: '#8C8C8C',
    border: '#2E2E2E',
    borderSubtle: '#232323',
    accent: '#B6A7CD',
    accentSoft: 'rgba(182,167,205,0.14)',
    onAccent: '#0A0A0A',
    live: '#86EFAC',
    liveSoft: 'rgba(134,239,172,0.10)',
    attention: '#FCD573',
    attentionSoft: 'rgba(253,230,140,0.12)',
    /** Count badges: white text on it reads 4.7:1. */
    attentionSolid: '#B35309',
    danger: '#FCA5A5',
    dangerSoft: 'rgba(252,165,165,0.12)',
    info: '#67E8F9',
    infoSoft: 'rgba(103,232,249,0.12)',
    offline: '#6B6B6B',
  },
  light: {
    background: '#FFFFFF',
    surface: 'rgba(250,250,250,0.70)',
    card: '#FAFAFA',
    popover: '#FFFFFF',
    field: '#F4F4F5',
    fill: 'rgba(24,24,27,0.05)',
    pressed: 'rgba(24,24,27,0.07)',
    solidSurface: '#FAFAFA',
    solidCard: '#FFFFFF',
    solidField: '#F4F4F5',
    rim: 'rgba(255,255,255,0.65)',
    sheen: 'rgba(255,255,255,0.24)',
    glint: 'rgba(112,91,141,0.08)',
    glow: 'rgba(112,91,141,0.028)',
    floor: 'rgba(101,217,146,0.012)',
    text: '#0A0A0A',
    secondary: '#3F3F46',
    muted: '#6C6C75',
    border: '#E4E4E7',
    borderSubtle: '#EFEFF1',
    accent: '#705B8D',
    accentSoft: 'rgba(112,91,141,0.10)',
    onAccent: '#FFFFFF',
    live: '#1B6A35',
    liveSoft: 'rgba(27,106,53,0.09)',
    attention: '#955104',
    attentionSoft: 'rgba(179,83,9,0.09)',
    attentionSolid: '#B35309',
    danger: '#DC2828',
    dangerSoft: 'rgba(220,40,40,0.08)',
    info: '#0F5F6B',
    infoSoft: 'rgba(15,95,107,0.08)',
    offline: '#6B6B6B',
  },
};
export type Theme = typeof themes.dark & {
  solid: boolean;
  dark: boolean;
  blur: number;
  saturation: number;
};
export type Tone = 'neutral' | 'accent' | 'live' | 'attention' | 'danger' | 'info';

/** One type ramp for the app. 13, 11 and 10pt are deliberately absent: 12 is the floor. */
export const type = {
  largeTitle: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.6 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 25, fontWeight: '400' },
  row: { fontSize: 16, lineHeight: 21, fontWeight: '500' },
  secondary: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.2 },
  mono: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
} satisfies Record<string, TextStyle>;
export type TypeVariant = keyof typeof type;

export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const GUTTER = 20;

export function toneColors(t: Theme, tone: Tone) {
  return {
    neutral: { fg: t.secondary, bg: t.fill },
    accent: { fg: t.accent, bg: t.accentSoft },
    live: { fg: t.live, bg: t.liveSoft },
    attention: { fg: t.attention, bg: t.attentionSoft },
    danger: { fg: t.danger, bg: t.dangerSoft },
    info: { fg: t.info, bg: t.infoSoft },
  }[tone];
}

const SolidMaterial = createContext(false);
const TransparencyPreference = createContext<{
  level: Transparency;
  setLevel: (level: Transparency) => void;
}>({ level: 50, setLevel: () => {} });
const AppearancePreference = createContext<{
  mode: AppearanceMode;
  setMode: (mode: AppearanceMode) => void;
}>({ mode: 'system', setMode: () => {} });

/** Device appearance and Reduce Transparency apply across every screen and native control. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [solid, setSolid] = useState(false);
  const [storedLevel, setStoredLevel] = useState<Transparency | null>(null);
  const [storedMode, setStoredMode] = useState<AppearanceMode | null>(null);
  const mode = storedMode ?? 'system';
  useEffect(() => {
    let mounted = true;
    void readTransparency().then((saved) => {
      if (mounted) setStoredLevel((current) => current ?? saved);
    });
    void readAppearance().then((saved) => {
      // A choice made while the keychain loads takes precedence over the saved preference.
      if (mounted) setStoredMode((current) => current ?? saved);
    });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web') Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
  }, [mode]);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let mounted = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((value) => {
      if (mounted) setSolid(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setSolid);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  const setMode = (next: AppearanceMode) => {
    setStoredMode(next);
    void saveAppearance(next);
  };
  const setLevel = (next: Transparency) => {
    setStoredLevel(next);
    void saveTransparency(next);
  };
  return createElement(
    AppearancePreference.Provider,
    { value: { mode, setMode } },
    createElement(
      TransparencyPreference.Provider,
      { value: { level: storedLevel ?? 50, setLevel } },
      createElement(SolidMaterial.Provider, { value: solid }, children),
    ),
  );
}

export function useAppearance() {
  return useContext(AppearancePreference);
}

export function useTransparency() {
  return useContext(TransparencyPreference);
}

export function useTheme(): Theme {
  const system = useColorScheme();
  const { mode } = useAppearance();
  const dark = (mode === 'system' ? system : mode) !== 'light';
  const base = themes[dark ? 'dark' : 'light'];
  const reduced = useContext(SolidMaterial);
  const { level } = useTransparency();
  return glassTheme(base, dark, reduced ? 0 : level);
}

/** Desktop's five material steps; the atmosphere is deliberately independent of the level. */
export function glassTheme(base: typeof themes.dark, dark: boolean, level: Transparency): Theme {
  const step = level / 25;
  const solid = level === 0;
  const opacity = [1, 0.85, 0.7, 0.55, 0.4][step];
  const rim = (dark ? [0, 0.14, 0.19, 0.25, 0.3] : [0, 0.55, 0.65, 0.75, 0.85])[step];
  const sheen = (dark ? [0, 0.04, 0.05, 0.07, 0.08] : [0, 0.18, 0.24, 0.3, 0.36])[step];
  const tint = (dark ? [0, 0.1, 0.13, 0.16, 0.19] : [0, 0.06, 0.08, 0.1, 0.12])[step];
  return {
    ...base,
    solid,
    dark,
    surface: solid ? base.solidSurface : `rgba(${dark ? '10,10,10' : '250,250,250'},${opacity})`,
    rim: `rgba(255,255,255,${rim})`,
    sheen: `rgba(255,255,255,${sheen})`,
    glint: `rgba(${dark ? '182,167,205' : '112,91,141'},${tint})`,
    blur: [0, 10, 8, 6, 5][step],
    saturation: [1, 1.4, 1.6, 1.8, 1.8][step],
  };
}
