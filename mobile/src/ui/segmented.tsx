import { Pressable, View } from 'react-native';
import { Text } from './text';
import { radius, useTheme } from './theme';

// Reason: Selected and idle segments share one renderer.
// fallow-ignore-next-line complexity
function Segment({
  label,
  selected,
  onPress,
  tabs,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  tabs: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      aria-selected={selected}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={{
        flex: tabs ? undefined : 1,
        minWidth: 44,
        minHeight: 44,
        paddingHorizontal: 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: tabs ? 0 : radius.sm,
        borderBottomWidth: tabs ? 2 : 0,
        borderBottomColor: selected ? t.text : 'transparent',
        backgroundColor: !tabs && selected ? (t.dark ? '#3A3A3C' : '#FFFFFF') : 'transparent',
      }}
    >
      <Text
        variant="secondary"
        color={selected ? 'text' : 'secondary'}
        style={{ fontWeight: selected ? '600' : '500' }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Content views use text tabs; composer settings retain grouped choice controls.
export function Segmented<Id extends string>({
  items,
  value,
  onChange,
  tabs = false,
}: {
  items: ReadonlyArray<{ id: Id; label: string }>;
  value: Id;
  onChange: (id: Id) => void;
  tabs?: boolean;
}) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: tabs ? 24 : 0,
        padding: tabs ? 0 : 2,
        borderRadius: radius.sm + 2,
        backgroundColor: tabs ? 'transparent' : t.field,
      }}
    >
      {items.map((item) => (
        <Segment
          key={item.id}
          label={item.label}
          selected={item.id === value}
          tabs={tabs}
          onPress={() => onChange(item.id)}
        />
      ))}
    </View>
  );
}
