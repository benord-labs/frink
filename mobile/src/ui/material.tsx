import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme, type Theme } from './theme';

// React Native and its web renderer expose the same gradient syntax under different keys.
export function backgroundImage(value: string): ViewStyle {
  return Platform.OS === 'web'
    ? ({ backgroundImage: value } as ViewStyle)
    : { experimental_backgroundImage: value };
}

// Frink's Standard glass: 70% surface fill, a white rim and a faint primary glint.
// Static surfaces use lighting rather than backdrop blur, as on desktop.
export function glassStyle(t: Theme): ViewStyle {
  return {
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.border,
    ...(t.solid
      ? {}
      : {
          ...backgroundImage(`radial-gradient(ellipse at 0% 0%, ${t.sheen}, transparent 56%)`),
          boxShadow: `inset 1px 1px 0 ${t.rim}, inset -1px -1px 0 ${t.glint}`,
        }),
  };
}

export function Atmosphere() {
  const t = useTheme();
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: t.background },
        !t.solid &&
          backgroundImage(
            [
              `radial-gradient(ellipse at 92% 92%, ${t.glow}, transparent 52%)`,
              `radial-gradient(ellipse at 50% 108%, ${t.floor}, transparent 45%)`,
              'radial-gradient(ellipse at 6% 10%, rgba(255,255,255,0.045), transparent 46%)',
              'radial-gradient(ellipse at 80% 4%, rgba(255,255,255,0.035), transparent 50%)',
              'linear-gradient(180deg, rgba(255,255,255,0.04), transparent 24%)',
            ].join(', '),
          ),
      ]}
    />
  );
}
