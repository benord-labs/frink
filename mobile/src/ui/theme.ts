import { useColorScheme } from 'react-native';

// Native counterparts of src/renderer/styles/globals.css, not a separate brand palette.
export const themes = {
  dark: {
    background: '#050505',
    surface: '#0A0A0A',
    field: '#1A1A1A',
    text: '#E8E8E8',
    secondary: '#B8B8B8',
    muted: '#8C8C8C',
    border: '#2E2E2E',
    accent: '#A78BFA',
    onAccent: '#0B0A14',
    success: '#86EFAC',
    warning: '#FDE68A',
    danger: '#FCA5A5',
  },
  light: {
    background: '#FFFFFF',
    surface: '#FAFAFA',
    field: '#F4F4F5',
    text: '#18181B',
    secondary: '#3F3F46',
    muted: '#66666E',
    border: '#E4E4E7',
    accent: '#7C3AED',
    onAccent: '#FFFFFF',
    success: '#166534',
    warning: '#92400E',
    danger: '#B91C1C',
  },
};
export function useTheme() {
  return themes[useColorScheme() === 'light' ? 'light' : 'dark'];
}
