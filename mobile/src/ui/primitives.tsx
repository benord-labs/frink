import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type TextInputProps,
} from 'react-native';
import type { ComponentProps, ReactNode } from 'react';
import { useTheme } from './theme';
import { backgroundImage } from './material';

export function Label({
  children,
  muted = false,
  size = 16,
  bold = false,
  style,
}: {
  children: ReactNode;
  muted?: boolean;
  size?: number;
  bold?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const t = useTheme();
  return (
    <Text
      selectable
      style={[
        {
          color: muted ? t.muted : t.text,
          fontSize: size,
          fontWeight: bold ? '500' : '400',
          lineHeight: Math.round(size * 1.4),
          letterSpacing: size >= 24 ? -0.6 : 0,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
export function Icon({
  name,
  color,
  size = 22,
}: {
  name: ComponentProps<typeof Ionicons>['name'];
  color?: string;
  size?: number;
}) {
  const t = useTheme();
  return <Ionicons name={name} size={size} color={color ?? t.text} />;
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
  icon?: ComponentProps<typeof Ionicons>['name'];
  compact?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? children}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={compact ? 4 : undefined}
      onPress={onPress}
      // Reason: Visual variants combine compact size, tone and pressed/disabled feedback.
      // fallow-ignore-next-line complexity
      style={({ pressed }) => [
        {
          minHeight: compact ? 36 : 44,
          borderRadius: 6,
          paddingHorizontal: compact ? 12 : 16,
          paddingVertical: compact ? 7 : 10,
          flexDirection: 'row',
          gap: 7,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: secondary ? t.field : t.accent,
          borderWidth: 1,
          borderColor: secondary ? t.border : 'transparent',
          ...(secondary || t.solid
            ? {}
            : backgroundImage('linear-gradient(180deg, rgba(255,255,255,0.16), transparent 65%)')),
          opacity: disabled ? 0.42 : pressed ? 0.75 : 1,
          alignSelf: compact ? 'flex-start' : undefined,
        },
        style,
      ]}
    >
      {icon && (
        <Icon
          name={icon}
          size={17}
          color={destructive ? t.danger : secondary ? t.text : t.onAccent}
        />
      )}
      <Text
        style={{
          fontSize: 14,
          fontWeight: '500',
          flexShrink: 1,
          textAlign: 'center',
          color: destructive ? t.danger : secondary ? t.text : t.onAccent,
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
      {...props}
      style={[
        {
          minHeight: 46,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: 8,
          padding: 12,
          fontSize: 16,
          color: t.text,
          backgroundColor: t.field,
          textAlignVertical: 'top',
        },
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
      style={{
        padding: 14,
        borderRadius: 8,
        backgroundColor: t.field,
        flexDirection: 'row',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <Icon
        name={error ? 'alert-circle-outline' : 'information-circle-outline'}
        color={error ? t.danger : t.muted}
        size={20}
      />
      <Text
        style={{
          flex: 1,
          color: error ? t.danger : t.secondary,
          fontSize: 14,
          lineHeight: 21,
        }}
      >
        {children}
      </Text>
    </View>
  );
}
// Reason: Root and detail screens share the same responsive header and content frame.
// fallow-ignore-next-line complexity
export function Page({
  title,
  subtitle,
  children,
  onBack,
  action,
  compact = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onBack?: () => void;
  action?: ReactNode;
  compact?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1 }}>
      {onBack && (
        <View
          style={{
            minHeight: 54,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 6,
            borderBottomWidth: 1,
            borderColor: t.border,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={onBack}
            style={{ width: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
          >
            <Icon name="chevron-back" size={23} color={t.text} />
          </Pressable>
          <Text
            accessibilityRole="header"
            numberOfLines={2}
            style={{
              flex: 1,
              color: t.text,
              fontSize: 17,
              lineHeight: 22,
              fontWeight: '600',
              textAlign: 'center',
            }}
          >
            {title}
          </Text>
          <View style={{ minWidth: 44, alignItems: 'flex-end' }}>{action}</View>
        </View>
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: onBack ? 20 : 14,
          paddingBottom: 24,
          gap: compact ? 20 : 24,
        }}
      >
        {!onBack && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Label
                size={20}
                bold
                style={{ fontWeight: '600', lineHeight: 26, letterSpacing: -0.3 }}
              >
                {title}
              </Label>
              {subtitle && (
                <Label muted size={14}>
                  {subtitle}
                </Label>
              )}
            </View>
            {action}
          </View>
        )}
        {onBack && subtitle && (
          <Label muted size={14}>
            {subtitle}
          </Label>
        )}
        {children}
      </ScrollView>
    </View>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Label size={13} muted bold>
        {title}
      </Label>
      {children}
    </View>
  );
}
// Reason: The shared MVP row handles optional icon, subtitle, status, and action states.
// fallow-ignore-next-line complexity
export function Row({
  title,
  subtitle,
  status,
  onPress,
  icon = 'chevron-forward',
}: {
  title: string;
  subtitle?: string;
  status?: string | null;
  onPress?: () => void;
  icon?: ComponentProps<typeof Ionicons>['name'];
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        minHeight: 64,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderColor: t.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      {icon !== 'chevron-forward' && (
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            backgroundColor: t.field,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} color={t.secondary} size={18} />
        </View>
      )}
      <View style={{ flex: 1, gap: 3 }}>
        <Label bold size={15}>
          {title}
        </Label>
        {subtitle ? (
          <Label size={13} muted>
            {subtitle}
          </Label>
        ) : null}
        {status && <Status value={status} />}
      </View>
      {onPress && <Icon name="chevron-forward" color={t.muted} size={15} />}
    </Pressable>
  );
}
export function Status({ value }: { value: string }) {
  const t = useTheme();
  const color = /fail|error|cancel/.test(value)
    ? t.danger
    : /await|pause|plan_ready|blocked|attention/.test(value)
      ? t.warning
      : /running|complete|done/.test(value)
        ? t.success
        : t.muted;
  const label = value.replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ fontSize: 12, lineHeight: 18, color }}>{label}</Text>
    </View>
  );
}
export function Loading() {
  const t = useTheme();
  return (
    <ActivityIndicator accessibilityLabel="Loading" color={t.accent} style={{ padding: 28 }} />
  );
}
