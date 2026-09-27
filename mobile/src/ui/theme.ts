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
    surface: 'rgba(10,10,10,0.7)',
    field: 'rgba(31,31,31,0.7)',
    solidSurface: '#0A0A0A',
    solidField: '#1F1F1F',
    rim: 'rgba(255,255,255,0.19)',
    sheen: 'rgba(255,255,255,0.05)',
    glint: 'rgba(167,139,250,0.13)',
    glow: 'rgba(167,139,250,0.06)',
    floor: 'rgba(125,240,168,0.03)',
    text: '#E8E8E8',
    secondary: '#B8B8B8',
    muted: '#8C8C8C',
    border: 'rgba(255,255,255,0.09)',
    accent: '#A78BFA',
    onAccent: '#0B0A14',
    success: '#86EFAC',
    warning: '#FDE68A',
    danger: '#FCA5A5',
  },
  light: {
    background: '#FFFFFF',
    surface: 'rgba(250,250,250,0.7)',
    field: 'rgba(244,244,245,0.7)',
    solidSurface: '#FAFAFA',
    solidField: '#F4F4F5',
    rim: 'rgba(255,255,255,0.65)',
    sheen: 'rgba(255,255,255,0.24)',
    glint: 'rgba(124,58,237,0.08)',
    glow: 'rgba(124,58,237,0.028)',
    floor: 'rgba(101,217,146,0.012)',
    text: '#18181B',
    secondary: '#3F3F46',
    muted: '#66666E',
    border: 'rgba(24,24,27,0.1)',
    accent: '#7C3AED',
    onAccent: '#FFFFFF',
    success: '#166534',
    warning: '#92400E',
    danger: '#B91C1C',
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
  return {
    ...base,
    solid,
    surface: solid ? base.solidSurface : base.surface,
    field: solid ? base.solidField : base.field,
  };
}
