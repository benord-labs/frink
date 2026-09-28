import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Chrome } from './chrome';
import { Icon } from './primitives';
import { useTheme } from './theme';

export type Tab = 'queue' | 'flows' | 'chats';

const tabs = [
  { id: 'queue', name: 'Queue', icon: 'file-tray-stacked', idle: 'file-tray-stacked-outline' },
  { id: 'flows', name: 'Flows', icon: 'git-network', idle: 'git-network-outline' },
  { id: 'chats', name: 'Chats', icon: 'chatbubbles', idle: 'chatbubbles-outline' },
] as const;

// Reason: Selected, idle and badged tabs share one tab renderer.
// fallow-ignore-next-line complexity
function TabButton({
  item,
  selected,
  badge,
  onPress,
}: {
  item: (typeof tabs)[number];
  selected: boolean;
  badge: number;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={item.name}
      accessibilityValue={badge ? { text: `${badge} need you` } : undefined}
      accessibilityState={{ selected }}
      aria-selected={selected}
      onPress={onPress}
      style={styles.tab}
    >
      <View>
        <Icon
          name={selected ? item.icon : item.idle}
          size={23}
          color={selected ? t.accent : t.muted}
        />
        {badge > 0 && (
          <View
            testID="queue-badge"
            style={[styles.badge, { backgroundColor: t.warning, borderColor: t.background }]}
          >
            <Text
              maxFontSizeMultiplier={1.2}
              style={{ fontSize: 11, lineHeight: 14, fontWeight: '700', color: t.background }}
            >
              {badge > 99 ? '99+' : badge}
            </Text>
          </View>
        )}
      </View>
      <Text
        maxFontSizeMultiplier={1.2}
        style={{
          fontSize: 12,
          lineHeight: 14,
          fontWeight: '600',
          color: selected ? t.accent : t.muted,
        }}
      >
        {item.name}
      </Text>
    </Pressable>
  );
}

export function TabBar({
  tab,
  onChange,
  needsYou,
  bottomInset,
}: {
  tab: Tab;
  onChange: (tab: Tab) => void;
  needsYou: number;
  bottomInset: number;
}) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        paddingBottom: bottomInset,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: t.border,
      }}
    >
      <Chrome />
      {tabs.map((item) => (
        <TabButton
          key={item.id}
          item={item}
          selected={tab === item.id}
          badge={item.id === 'queue' ? needsYou : 0}
          onPress={() => onChange(item.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -5,
    left: 15,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tab: {
    flex: 1,
    minHeight: 54,
    paddingTop: 7,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 3,
  },
});
