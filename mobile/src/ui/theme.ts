import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Platform, useColorScheme } from 'react-native';

// Native counterparts of src/renderer/styles/globals.css, not a separate brand palette.
export const themes = {
  dark: {
    background: '#050505',
    surface: 'rgba(10,10,10,0.72)',
    card: 'rgba(255,255,255,0.045)',
    field: 'rgba(255,255,255,0.07)',
    fill: 'rgba(255,255,255,0.06)',
    raised: 'rgba(255,255,255,0.13)',
    solidSurface: '#0A0A0A',
    solidCard: '#111111',
    solidField: '#1A1A1A',
    rim: 'rgba(255,255,255,0.12)',
    sheen: 'rgba(255,255,255,0.04)',
    glint: 'rgba(167,139,250,0.10)',
    glow: 'rgba(167,139,250,0.06)',
    floor: 'rgba(125,240,168,0.03)',
    text: '#E8E8E8',
    secondary: '#B8B8B8',
    muted: '#8C8C8C',
    border: 'rgba(255,255,255,0.08)',
    accent: '#A78BFA',
    accentSoft: 'rgba(167,139,250,0.14)',
    onAccent: '#0B0A14',
    success: '#86EFAC',
    successSoft: 'rgba(134,239,172,0.12)',
    warning: '#FDE68A',
    warningSoft: 'rgba(253,230,138,0.12)',
    danger: '#FCA5A5',
    dangerSoft: 'rgba(252,165,165,0.12)',
  },
  light: {
    background: '#F4F4F6',
    surface: 'rgba(248,248,250,0.78)',
    card: 'rgba(255,255,255,0.82)',
    field: 'rgba(24,24,27,0.05)',
    fill: 'rgba(24,24,27,0.05)',
    raised: '#FFFFFF',
    solidSurface: '#F8F8FA',
    solidCard: '#FFFFFF',
    solidField: '#EDEDF0',
    rim: 'rgba(255,255,255,0.9)',
    sheen: 'rgba(255,255,255,0.3)',
    glint: 'rgba(124,58,237,0.06)',
    glow: 'rgba(124,58,237,0.028)',
    floor: 'rgba(101,217,146,0.012)',
    text: '#18181B',
    secondary: '#3F3F46',
    muted: '#66666E',
    border: 'rgba(24,24,27,0.09)',
    accent: '#7C3AED',
    accentSoft: 'rgba(124,58,237,0.10)',
    onAccent: '#FFFFFF',
    success: '#166534',
    successSoft: 'rgba(22,101,52,0.09)',
    warning: '#92400E',
    warningSoft: 'rgba(146,64,14,0.08)',
    danger: '#B91C1C',
    dangerSoft: 'rgba(185,28,28,0.08)',
  },
};
export type Theme = typeof themes.dark & { solid: boolean };
const SolidMaterial = createContext(false);

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
  const base = themes[useColorScheme() === 'light' ? 'light' : 'dark'];
  const solid = useContext(SolidMaterial);
  const opaque = solid
    ? { surface: base.solidSurface, card: base.solidCard, field: base.solidField }
    : {};
  return { ...base, solid, ...opaque };
}
