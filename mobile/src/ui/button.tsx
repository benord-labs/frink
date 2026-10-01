import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Text } from './text';
import { radius, space, useTheme } from './theme';

type Variant = 'primary' | 'secondary' | 'destructive' | 'plain';

export function Button({
  children,
  onPress,
  variant = 'primary',
  icon: Icon,
  disabled = false,
  busy = false,
  small = false,
  accessibilityLabel,
  style,
}: {
  children: string;
  onPress: () => void;
  variant?: Variant;
  icon?: LucideIcon;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const fg = {
    primary: t.onAccent,
    secondary: t.text,
    destructive: t.danger,
    plain: t.accent,
  }[variant];
  const bg = {
    primary: t.accent,
    secondary: t.field,
    destructive: t.dangerSoft,
    plain: 'transparent',
  }[variant];
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? children}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: small ? 36 : 50,
          paddingHorizontal: small ? space.md + 2 : space.xl,
          borderRadius: radius.pill,
          backgroundColor: bg,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.sm,
          opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
          boxShadow:
            variant === 'primary' ? 'inset 0 1px 0 rgba(255,255,255,0.25)' : undefined,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        Icon && <Icon size={small ? 16 : 18} color={fg} strokeWidth={2.2} />
      )}
      <Text variant={small ? 'secondary' : 'headline'} style={{ color: fg, fontWeight: '600' }}>
        {children}
      </Text>
    </Pressable>
  );
}

/** A round icon-only control (44pt hit area); label is for VoiceOver. */
export function IconButton({
  icon: Icon,
  label,
  onPress,
  tone = 'neutral',
  size = 36,
  disabled = false,
  testID,
  children,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  tone?: 'neutral' | 'accent' | 'danger' | 'inverse';
  size?: number;
  disabled?: boolean;
  testID?: string;
  children?: ReactNode;
}) {
  const t = useTheme();
  const colors = {
    neutral: { fg: t.text, bg: t.fill },
    accent: { fg: t.onAccent, bg: t.accent },
    danger: { fg: t.danger, bg: t.dangerSoft },
    inverse: { fg: t.background, bg: t.text },
  }[tone];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={(44 - size) / 2}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : pressed ? 0.75 : 1,
      })}
    >
      <Icon size={size * 0.5} color={colors.fg} strokeWidth={2.2} />
      {children && <View style={{ position: 'absolute' }}>{children}</View>}
    </Pressable>
  );
}
