import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type TextInputProps,
} from 'react-native';
import type { ComponentProps, ReactNode } from 'react';
import { useTheme, type Theme } from './theme';
import { glassStyle } from './material';

export type IconName = ComponentProps<typeof Ionicons>['name'];
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

// One spacing and shape scale for every screen: 16pt gutters, 14pt cards, 12pt controls.
export const GUTTER = 16;
export const ROW_INSET = 14;
const TILE = 30;
export const SEPARATOR_INSET = ROW_INSET + TILE + 12;

// Web draws a focus ring inside borderless inputs that already sit in a styled frame.
export const bareInput: TextStyle =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : {};

export function toneColors(t: Theme, tone: Tone) {
  return {
    neutral: { fg: t.secondary, bg: t.fill },
    accent: { fg: t.accent, bg: t.accentSoft },
    success: { fg: t.success, bg: t.successSoft },
    warning: { fg: t.warning, bg: t.warningSoft },
    danger: { fg: t.danger, bg: t.dangerSoft },
  }[tone];
}

function lineHeight(size: number) {
  return size <= 14 ? size + 6 : Math.round(size * 1.375);
}

export function Label({
  children,
  muted = false,
  size = 16,
  bold = false,
  lines,
  style,
}: {
  children: ReactNode;
  muted?: boolean;
  size?: number;
  bold?: boolean;
  lines?: number;
  style?: StyleProp<TextStyle>;
}) {
  const t = useTheme();
  return (
    <Text
      selectable
      numberOfLines={lines}
      style={[
        {
          color: muted ? t.muted : t.text,
          fontSize: size,
          fontWeight: bold ? '600' : '400',
          lineHeight: lineHeight(size),
          letterSpacing: size >= 24 ? -0.5 : 0,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
export function Icon({ name, color, size = 22 }: { name: IconName; color?: string; size?: number }) {
  const t = useTheme();
  return <Ionicons name={name} size={size} color={color ?? t.text} />;
}
export function IconTile({ name, tone = 'neutral' }: { name: IconName; tone?: Tone }) {
  const t = useTheme();
  const { fg, bg } = toneColors(t, tone);
  return (
    <View
      style={{
        width: TILE,
        height: TILE,
        borderRadius: 8,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={name} size={17} color={fg} />
    </View>
  );
}
// Reason: The shared action exposes icon, tone and size variants without duplicating controls.
// fallow-ignore-next-line complexity
export function Button({
  children,
  onPress,
  disabled = false,
  secondary = false,
  destructive = false,
  icon,
  compact = false,
  accessibilityLabel,
  style,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  destructive?: boolean;
  icon?: IconName;
  compact?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const color = destructive ? t.danger : secondary ? t.text : t.onAccent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? children}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={compact ? 4 : undefined}
      // Reason: Visual variants combine compact size, tone and pressed/disabled feedback.
      // fallow-ignore-next-line complexity
      style={({ pressed }) => [
        {
          minHeight: compact ? 36 : 46,
          borderRadius: compact ? 10 : 12,
          paddingHorizontal: compact ? 14 : 18,
          paddingVertical: compact ? 8 : 12,
          flexDirection: 'row',
          gap: 6,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: secondary ? t.field : t.accent,
          // Frink's stamped primary: a hairline ring with a faint inset highlight.
          boxShadow: secondary
            ? undefined
            : '0 0 0 0.5px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.22)',
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
          alignSelf: compact ? 'flex-start' : undefined,
        },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={compact ? 16 : 18} color={color} />}
      <Text
        style={{
          flexShrink: 1,
          textAlign: 'center',
          fontSize: compact ? 15 : 16,
          lineHeight: 20,
          fontWeight: '600',
          color,
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}
export function Field(props: TextInputProps) {
  const t = useTheme();
  return (
    <TextInput
      placeholderTextColor={t.muted}
      selectionColor={t.accent}
      {...props}
      style={[
        {
          minHeight: 46,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.border,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 16,
          lineHeight: 22,
          color: t.text,
          backgroundColor: t.field,
          textAlignVertical: props.multiline ? 'top' : 'center',
        },
        bareInput,
        props.style,
      ]}
    />
  );
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  const t = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon
          name={error ? 'alert-circle' : 'information-circle-outline'}
          color={error ? t.danger : t.muted}
          size={18}
        />
      </View>
      <Text
        style={{ flex: 1, color: error ? t.danger : t.secondary, fontSize: 14, lineHeight: 20 }}
      >
        {children}
      </Text>
    </View>
  );
}
// A framed glass group: every list, form and outline on the phone sits in one of these.
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View
      style={[
        { ...glassStyle(t), borderWidth: StyleSheet.hairlineWidth, borderRadius: 14 },
        { overflow: 'hidden' },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function CardNote({ children }: { children: ReactNode }) {
  return (
    <View style={{ paddingHorizontal: ROW_INSET, paddingVertical: 14 }}>
      <Label muted size={14}>
        {children}
      </Label>
    </View>
  );
}
export function Section({
  title,
  count,
  children,
  plain = false,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  plain?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
        <Text
          accessibilityRole="header"
          style={{ color: t.secondary, fontSize: 15, lineHeight: 20, fontWeight: '600' }}
        >
          {title}
        </Text>
        {count !== undefined && (
          <View
            style={{
              minWidth: 20,
              height: 20,
              paddingHorizontal: 6,
              borderRadius: 10,
              backgroundColor: t.fill,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: t.secondary, fontSize: 12, lineHeight: 16, fontWeight: '600' }}>
              {count}
            </Text>
          </View>
        )}
      </View>
      {plain ? children : <Card>{children}</Card>}
    </View>
  );
}

// One row anatomy for queues, chats, automations and run history: tile, two lines, one slot.
// Reason: Optional content and navigation semantics share one consistent mobile list control.
// fallow-ignore-next-line complexity
export function Row({
  title,
  subtitle,
  status,
  trailing,
  onPress,
  icon = 'chatbubble-outline',
  tone = 'neutral',
  accessibilityLabel,
  testID,
  separator = false,
  selected,
  dimmed = false,
}: {
  title: string;
  subtitle?: string;
  status?: string | null;
  trailing?: ReactNode;
  onPress?: () => void;
  icon?: IconName;
  tone?: Tone;
  accessibilityLabel?: string;
  testID?: string;
  separator?: boolean;
  selected?: boolean;
  dimmed?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={selected !== undefined ? 'radio' : onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? (selected !== undefined ? title : undefined)}
      aria-checked={selected}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        paddingHorizontal: ROW_INSET,
        paddingVertical: 12,
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? t.fill : 'transparent',
      })}
    >
      <View style={{ opacity: dimmed ? 0.55 : 1 }}>
        <IconTile name={icon} tone={tone} />
      </View>
      <View
        testID={testID ? `${testID}-body` : undefined}
        style={{ flex: 1, minWidth: 0, gap: 2, opacity: dimmed ? 0.6 : 1 }}
      >
        <Label size={16} lines={2} style={{ lineHeight: 21, fontWeight: '500' }}>
          {title}
        </Label>
        {!!subtitle && (
          <Label size={14} muted lines={2} style={{ lineHeight: 19 }}>
            {subtitle}
          </Label>
        )}
      </View>
      {trailing}
      {!!status && <Status value={status} />}
      {selected !== undefined
        ? selected && <Icon name="checkmark" color={t.accent} size={20} />
        : onPress && <Icon name="chevron-forward" color={t.muted} size={16} />}
      {separator && (
        <View
          style={{
            position: 'absolute',
            left: SEPARATOR_INSET,
            right: 0,
            bottom: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: t.border,
          }}
        />
      )}
    </Pressable>
  );
}
export function statusTone(value: string): Tone {
  if (/fail|error/.test(value)) return 'danger';
  if (/await|pause|plan_ready|blocked|attention/.test(value)) return 'warning';
  if (/running/.test(value)) return 'success';
  return 'neutral';
}
export function Status({ value }: { value: string }) {
  const t = useTheme();
  const { fg, bg } = toneColors(t, statusTone(value));
  const label = value.replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minHeight: 22,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 11,
        backgroundColor: bg,
        alignSelf: 'center',
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: fg }} />
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.6}
        style={{ fontSize: 12, lineHeight: 16, fontWeight: '600', color: fg }}
      >
        {label}
      </Text>
    </View>
  );
}
export function Loading() {
  const t = useTheme();
  return (
    <ActivityIndicator accessibilityLabel="Loading" color={t.accent} style={{ padding: 28 }} />
  );
}
