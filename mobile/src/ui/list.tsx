import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Text } from './text';
import { glassLighting } from './material';
import { GUTTER, radius, space, useTheme } from './theme';

/**
 * The one list row: leading tile, a title over one supporting line, and a fixed right slot.
 * Line two carries a single meaning (kind · project, or the state in words), never a metadata run.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onPress,
  onLongPress,
  testID,
  accessibilityLabel,
  dimmed = false,
  titleLines = 1,
  compact = false,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  dimmed?: boolean;
  titleLines?: number;
  compact?: boolean;
}) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        minHeight: compact ? 48 : 64,
        paddingHorizontal: GUTTER,
        paddingVertical: 10,
        backgroundColor: pressed ? t.pressed : 'transparent',
        opacity: dimmed ? 0.55 : 1,
      })}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant="row" numberOfLines={fontScale > 1.2 ? undefined : titleLines}>
          {title}
        </Text>
        {typeof subtitle === 'string' ? (
          <Text variant="secondary" color="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {trailing && <View style={{ alignItems: 'flex-end', gap: 2 }}>{trailing}</View>}
    </Pressable>
  );
}

/** Related work stays visibly grouped while retaining the shared glass rim. */
export function ListGroup({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View
      style={{
        marginHorizontal: GUTTER,
        borderRadius: radius.lg,
        overflow: 'hidden',
        backgroundColor: t.surface,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        ...glassLighting(t),
      }}
    >
      {Children.toArray(children).map((child, index) => (
        <Fragment key={index}>
          {index > 0 && <RowSeparator inset={GUTTER} />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

/** A hairline that starts under the row text, so tiles read as a column. */
export function RowSeparator({ inset = GUTTER + 38 + space.md }: { inset?: number }) {
  const t = useTheme();
  return (
    <View
      style={{ height: StyleSheet.hairlineWidth, marginLeft: inset, backgroundColor: t.border }}
    />
  );
}

export function SectionHeader({
  title,
  count,
  action,
  onAction,
}: {
  title: string;
  count?: number;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View
      accessibilityRole="header"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: GUTTER,
        paddingTop: space.lg,
        paddingBottom: space.sm,
        gap: space.sm,
      }}
    >
      <Text variant="secondary" style={{ fontWeight: '600' }}>
        {title}
      </Text>
      {count != null && (
        <Text variant="secondary" color="muted">
          {count}
        </Text>
      )}
      <View style={{ flex: 1 }} />
      {action && onAction && (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={10}>
          <Text variant="secondary" color="accent" style={{ fontWeight: '600' }}>
            {action}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** One calm centred message with an optional next step. */
export function EmptyState({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        alignItems: 'center',
        paddingHorizontal: space.xxl,
        paddingVertical: 56,
        gap: space.sm,
      }}
    >
      {Icon && (
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: radius.lg,
            backgroundColor: t.fill,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: space.sm,
          }}
        >
          <Icon size={24} color={t.muted} />
        </View>
      )}
      <Text variant="headline" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      {detail && (
        <Text variant="secondary" color="muted" style={{ textAlign: 'center' }}>
          {detail}
        </Text>
      )}
      {action && <View style={{ marginTop: space.md }}>{action}</View>}
    </View>
  );
}
