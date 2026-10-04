import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
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
export function glassLighting(t: Theme): ViewStyle {
  if (t.solid) return {};
  return {
    ...backgroundImage(`radial-gradient(ellipse at 0% 0%, ${t.sheen}, transparent 56%)`),
    boxShadow: `inset 1px 1px 0 ${t.rim}, inset -1px -1px 0 ${t.glint}`,
  };
}

const nativeGlass = Platform.OS === 'ios' && isLiquidGlassAvailable();

/**
 * One material for everything that floats over moving content (composer, pills, sheets' chrome).
 * iOS 26+ gets Apple's Liquid Glass; older iOS and web get a backdrop blur with Frink's rim;
 * Reduce Transparency gets a solid fill.
 */
export function GlassSurface({
  children,
  style,
  interactive = false,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
}) {
  const t = useTheme();
  if (t.solid)
    return (
      <View style={[{ backgroundColor: t.popover, borderWidth: 1, borderColor: t.border }, style]}>
        {children}
      </View>
    );
  if (nativeGlass)
    return (
      <GlassView
        glassEffectStyle="regular"
        isInteractive={interactive}
        colorScheme={t.dark ? 'dark' : 'light'}
        style={style}
      >
        {children}
      </GlassView>
    );
  // The blur and the rim are separate layers: each takes the surface's corners, or the rim
  // runs straight across a rounded edge.
  const { borderRadius } = StyleSheet.flatten(style) ?? {};
  const layer = [StyleSheet.absoluteFill, { borderRadius }];
  return (
    <View style={[{ overflow: 'hidden', borderWidth: 1, borderColor: t.borderSubtle }, style]}>
      <BlurView
        tint={t.dark ? 'dark' : 'light'}
        intensity={60}
        style={[layer, { backgroundColor: t.surface }]}
      />
      <View pointerEvents="none" style={[layer, glassLighting(t)]} />
      {children}
    </View>
  );
}

/** The chat and onboarding backdrop: desktop's violet glow and green floor. Lists stay flat. */
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
