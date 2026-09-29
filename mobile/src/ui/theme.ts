import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Platform, useColorScheme, type TextStyle } from 'react-native';

// Native counterparts of src/renderer/styles/globals.css, not a separate brand palette.
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
    glint: 'rgba(167,139,250,0.13)',
    glow: 'rgba(167,139,250,0.06)',
    floor: 'rgba(125,240,168,0.03)',
    text: '#E8E8E8',
    secondary: '#B8B8B8',
    muted: '#8C8C8C',
    border: '#2E2E2E',
    borderSubtle: '#232323',
    accent: '#A78BFA',
    accentSoft: 'rgba(167,139,250,0.14)',
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
    glint: 'rgba(124,58,237,0.08)',
    glow: 'rgba(124,58,237,0.028)',
    floor: 'rgba(101,217,146,0.012)',
    text: '#0A0A0A',
    secondary: '#3F3F46',
    muted: '#6C6C75',
    border: '#E4E4E7',
    borderSubtle: '#EFEFF1',
    accent: '#7C3AED',
    accentSoft: 'rgba(124,58,237,0.10)',
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
export type Theme = typeof themes.dark & { solid: boolean; dark: boolean };
export type Tone = 'neutral' | 'accent' | 'live' | 'attention' | 'danger' | 'info';

/** One type ramp for the app. 13, 11 and 10pt are deliberately absent: 12 is the floor. */
export const type = {
  largeTitle: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.6 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
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
export const GUTTER = space.lg;

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

/** iOS Reduce Transparency makes every glass surface solid, as desktop's reduced-transparency. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [solid, setSolid] = useState(false);
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
  return createElement(SolidMaterial.Provider, { value: solid }, children);
}

export function useTheme(): Theme {
  const dark = useColorScheme() !== 'light';
  const base = themes[dark ? 'dark' : 'light'];
  const solid = useContext(SolidMaterial);
  return { ...base, surface: solid ? base.solidSurface : base.surface, solid, dark };
}
