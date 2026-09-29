import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Check, type LucideIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../../ui/theme';

/** A native page sheet for one composer choice: centred title, Done, and flat grouped rows. */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.popover }}>
        <View
          style={{
            height: 58,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text accessibilityRole="header" variant="headline">
            {title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={onClose}
            hitSlop={10}
            style={({ pressed }) => ({
              position: 'absolute',
              right: GUTTER,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text variant="headline" color="accent">
              Done
            </Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={{ paddingBottom: space.xl + insets.bottom, gap: space.xl }}
        >
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** A labelled group of rows; the label names the choice, rows sit flat on the sheet. */
export function SheetSection({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: space.xs }}>
      {title && (
        <Text variant="label" color="muted" style={{ paddingHorizontal: GUTTER, paddingBottom: 2 }}>
          {title}
        </Text>
      )}
      {children}
      {footer && (
        <Text
          variant="secondary"
          color="muted"
          style={{ paddingHorizontal: GUTTER, paddingTop: 4 }}
        >
          {footer}
        </Text>
      )}
    </View>
  );
}

const ICON_TILE = 32;

function IconTile({ icon: Icon, active }: { icon: LucideIcon; active: boolean }) {
  const t = useTheme();
  return (
    <View
      style={{
        width: ICON_TILE,
        height: ICON_TILE,
        borderRadius: radius.sm + 1,
        backgroundColor: t.fill,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon size={17} color={active ? t.accent : t.secondary} strokeWidth={2} />
    </View>
  );
}

function Separator() {
  const t = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        marginLeft: GUTTER + ICON_TILE + space.md,
        backgroundColor: t.border,
      }}
    />
  );
}

/** One pickable row: tile, name over a one-line explanation, and a check when chosen. */
export function OptionRow({
  icon,
  title,
  subtitle,
  selected = false,
  dimmed = false,
  separator = false,
  onPress,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  selected?: boolean;
  dimmed?: boolean;
  separator?: boolean;
  onPress?: () => void;
}) {
  const t = useTheme();
  return (
    <>
      <Pressable
        accessibilityRole="radio"
        accessibilityLabel={title}
        aria-checked={selected}
        accessibilityState={{ checked: selected, disabled: !onPress }}
        disabled={!onPress}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          minHeight: subtitle ? 62 : 52,
          paddingHorizontal: GUTTER,
          paddingVertical: 10,
          backgroundColor: pressed ? t.pressed : 'transparent',
          opacity: dimmed ? 0.5 : 1,
        })}
      >
        <IconTile icon={icon} active={selected} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text variant="row">{title}</Text>
          {subtitle && (
            <Text variant="secondary" color="muted" numberOfLines={2}>
              {subtitle}
            </Text>
          )}
        </View>
        <View style={{ width: 22, alignItems: 'flex-end' }}>
          {selected && <Check size={20} color={t.accent} strokeWidth={2.4} />}
        </View>
      </Pressable>
      {separator && <Separator />}
    </>
  );
}

export function SwitchRow({
  icon,
  label,
  detail,
  value,
  onChange,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  detail: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        minHeight: 62,
        paddingHorizontal: GUTTER,
        paddingVertical: 10,
      }}
    >
      <IconTile icon={icon} active={value && !disabled} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant="row">{label}</Text>
        <Text variant="secondary" color="muted">
          {detail}
        </Text>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        trackColor={{ true: t.accent, false: t.border }}
        thumbColor="#FFFFFF"
        {...(Platform.OS === 'web' ? { activeThumbColor: '#FFFFFF' } : {})}
        onValueChange={onChange}
      />
    </View>
  );
}
