import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
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
          fontWeight: bold ? '600' : '400',
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
      onPress={onPress}
      // Reason: Visual variants combine compact size, tone and pressed/disabled feedback.
      // fallow-ignore-next-line complexity
      style={({ pressed }) => [
        {
          minHeight: 44,
          borderRadius: 6,
          paddingHorizontal: 16,
          paddingVertical: 10,
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
          fontSize: 15,
          lineHeight: 22,
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
          minHeight: 48,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: 8,
          padding: 12,
          fontSize: 16,
          lineHeight: 22,
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
        flexDirection: 'row',
        gap: 8,
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
// Reason: Root, setup and detail screens share one content frame without duplicate layouts.
// fallow-ignore-next-line complexity
export function Page({
  title,
  subtitle,
  children,
  onBack,
  action,
  root = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onBack?: () => void;
  action?: ReactNode;
  root?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1 }}>
      {onBack && (
        <View
          style={{
            minHeight: 56,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderColor: t.border,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={onBack}
            style={{ width: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
          >
            <Icon name="chevron-back" size={23} />
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
          paddingHorizontal: 20,
          paddingTop: 24,
          paddingBottom: 20,
          gap: 24,
        }}
      >
        {!onBack && !root && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text
              accessibilityRole="header"
              style={{
                flex: 1,
                color: t.text,
                fontSize: 24,
                lineHeight: 30,
                fontWeight: '600',
                letterSpacing: -0.5,
              }}
            >
              {title}
            </Text>
            {action}
          </View>
        )}
        {subtitle && (
          <Label muted size={15}>
            {subtitle}
          </Label>
        )}
        {children}
      </ScrollView>
    </View>
  );
}

export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const t = useTheme();
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
        <Text
          accessibilityRole="header"
          style={{ color: t.muted, fontSize: 14, lineHeight: 20, fontWeight: '500' }}
        >
          {title}
        </Text>
        {count !== undefined && (
          <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{count}</Text>
        )}
      </View>
      <View>{children}</View>
    </View>
  );
}

// One row anatomy for queues, chats, automations and run history.
// Reason: Optional content and navigation semantics share one consistent mobile list control.
// fallow-ignore-next-line complexity
export function Row({
  title,
  subtitle,
  status,
  metadata,
  onPress,
  icon = 'chatbubble-outline',
  accessibilityLabel,
  testID,
  separator = false,
  selected,
}: {
  title: string;
  subtitle?: string;
  status?: string | null;
  metadata?: ReactNode;
  onPress?: () => void;
  icon?: ComponentProps<typeof Ionicons>['name'];
  accessibilityLabel?: string;
  testID?: string;
  separator?: boolean;
  selected?: boolean;
}) {
  const t = useTheme();
  return (
    <View>
      <Pressable
        testID={testID}
        accessibilityRole={selected !== undefined ? 'radio' : onPress ? 'button' : undefined}
        accessibilityLabel={accessibilityLabel ?? (selected !== undefined ? title : undefined)}
        aria-checked={selected}
        onPress={onPress}
        disabled={!onPress}
        style={({ pressed }) => ({
          paddingVertical: 16,
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 12,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View style={{ width: 20, height: 22, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} color={selected ? t.accent : t.muted} size={20} />
        </View>
        <View
          testID={testID ? `${testID}-body` : undefined}
          style={{ flex: 1, minWidth: 0, gap: 4 }}
        >
          <Label size={16} bold style={{ lineHeight: 22, fontWeight: '500' }}>
            {title}
          </Label>
          {!!subtitle && (
            <Label size={14} muted style={{ lineHeight: 20 }}>
              {subtitle}
            </Label>
          )}
          {!!status && <Status value={status} />}
          {metadata}
        </View>
        {onPress && selected === undefined && (
          <View style={{ height: 22, justifyContent: 'center' }}>
            <Icon name="chevron-forward" color={t.muted} size={16} />
          </View>
        )}
      </Pressable>
      {separator && (
        <View
          style={{ height: StyleSheet.hairlineWidth, marginLeft: 32, backgroundColor: t.border }}
        />
      )}
    </View>
  );
}
export function Status({ value }: { value: string }) {
  const t = useTheme();
  const color = /fail|error/.test(value)
    ? t.danger
    : /await|pause|plan_ready|blocked|attention/.test(value)
      ? t.warning
      : /running/.test(value)
        ? t.success
        : t.muted;
  const label = value.replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ fontSize: 13, lineHeight: 18, color }}>{label}</Text>
    </View>
  );
}
export function Loading() {
  const t = useTheme();
  return (
    <ActivityIndicator accessibilityLabel="Loading" color={t.accent} style={{ padding: 28 }} />
  );
}
