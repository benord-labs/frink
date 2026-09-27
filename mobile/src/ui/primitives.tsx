import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import type { ComponentProps, ReactNode } from 'react';
import { useTheme } from './theme';

export function Label({
  children,
  muted = false,
  size = 16,
  bold = false,
}: {
  children: ReactNode;
  muted?: boolean;
  size?: number;
  bold?: boolean;
}) {
  const t = useTheme();
  return (
    <Text
      selectable
      style={{
        color: muted ? t.muted : t.text,
        fontSize: size,
        fontWeight: bold ? '600' : '400',
        lineHeight: size * 1.45,
      }}
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
export function Button({
  children,
  onPress,
  disabled = false,
  secondary = false,
  destructive = false,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  destructive?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        borderRadius: 24,
        paddingHorizontal: 20,
        paddingVertical: 12,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: secondary ? t.field : t.accent,
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
      })}
    >
      <Text
        style={{
          fontSize: 16,
          fontWeight: '600',
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
          borderRadius: 10,
          padding: 13,
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
        borderRadius: 10,
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
export function Page({
  title,
  subtitle,
  children,
  onBack,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onBack?: () => void;
  action?: ReactNode;
}) {
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 20, paddingBottom: 32, gap: 22 }}
    >
      <View style={{ gap: 12 }}>
        {onBack && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={onBack}
            style={{
              minHeight: 44,
              minWidth: 44,
              justifyContent: 'center',
              alignSelf: 'flex-start',
            }}
          >
            <Icon name="arrow-back" />
          </Pressable>
        )}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <View style={{ flex: 1 }}>
            <Label size={28} bold>
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
      </View>
      {children}
    </ScrollView>
  );
}
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <Label size={19} bold>
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
        paddingVertical: 17,
        borderBottomWidth: 1,
        borderColor: t.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Label bold>{title}</Label>
        {subtitle ? (
          <Label size={13} muted>
            {subtitle}
          </Label>
        ) : null}
        {status && <Status value={status} />}
      </View>
      {onPress && <Icon name={icon} color={t.muted} size={20} />}
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
  return <Text style={{ fontSize: 13, lineHeight: 20, color }}>{value.replaceAll('_', ' ')}</Text>;
}
export function Loading() {
  const t = useTheme();
  return (
    <ActivityIndicator accessibilityLabel="Loading" color={t.accent} style={{ padding: 28 }} />
  );
}
