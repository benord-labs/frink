import { BlurView } from 'expo-blur';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme, type Theme } from './theme';

// React Native and its web renderer expose the same gradient syntax under different keys.
export function backgroundImage(value: string): ViewStyle {
  return Platform.OS === 'web'
    ? ({ backgroundImage: value } as ViewStyle)
    : { experimental_backgroundImage: value };
}

/** Frink Glass lighting: a white rim top-left, a faint primary glint bottom-right, a sheen. */
export function glassLighting(t: Theme, rim: 'all' | 'right' = 'all'): ViewStyle {
  if (t.solid) return {};
  return {
    ...backgroundImage(`radial-gradient(ellipse at 0% 0%, ${t.sheen}, transparent 56%)`),
    boxShadow:
      rim === 'right'
        ? `inset -1px 0 0 ${t.rim}`
        : `inset 1px 1px 0 ${t.rim}, inset -1px -1px 0 ${t.glint}`,
  };
}

/** Frink's shared tint and rim over backdrop blur; reduced transparency uses an opaque fill. */
export function GlassSurface({
  children,
  style,
  rim = 'all',
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  rim?: 'all' | 'right';
}) {
  const t = useTheme();
  const borders = rim === 'right' ? { borderRightWidth: 1 } : { borderWidth: 1 };
  if (t.solid)
    return (
      <View style={[{ backgroundColor: t.solidSurface, ...borders, borderColor: t.border }, style]}>
        {children}
      </View>
    );
  // The blur and the rim are separate layers: each takes the surface's corners, or the rim
  // runs straight across a rounded edge.
  const { borderRadius } = StyleSheet.flatten(style) ?? {};
  const layer = [StyleSheet.absoluteFill, { borderRadius }];
  const webBlur: ViewStyle & { backdropFilter: string } = {
    backdropFilter: `blur(${t.blur}px) saturate(${t.saturation})`,
  };
  return (
    <View style={[{ overflow: 'hidden', ...borders, borderColor: t.borderSubtle }, style]}>
      {Platform.OS === 'web' ? (
        <View pointerEvents="none" style={[layer, webBlur]} />
      ) : (
        <BlurView
          pointerEvents="none"
          tint={t.dark ? 'dark' : 'light'}
          intensity={t.blur * 5}
          style={layer}
        />
      )}
      <View
        pointerEvents="none"
        style={[layer, { backgroundColor: t.surface }, glassLighting(t, rim)]}
      />
      {children}
    </View>
  );
}

/** The chat and onboarding backdrop: desktop's violet glow and green floor. Its strength stays fixed across transparency levels. */
export function Atmosphere() {
  const t = useTheme();
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: t.background },
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
