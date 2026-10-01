import { Pressable, View } from 'react-native';
import { Text } from './text';
import { radius, useTheme } from './theme';

// Reason: Selected and idle segments share one renderer.
// fallow-ignore-next-line complexity
function Segment({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
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
        flex: 1,
        minWidth: 0,
        paddingVertical: 6,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: selected ? (t.dark ? '#3A3A3C' : '#FFFFFF') : 'transparent',
        boxShadow: selected ? '0 1px 3px rgba(0,0,0,0.18)' : undefined,
      }}
    >
      <Text
        variant="secondary"
        numberOfLines={1}
        color={selected ? 'text' : 'secondary'}
        style={{ fontWeight: selected ? '600' : '500' }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// iOS-style segmented control: one filled segment on a recessed track.
export function Segmented<Id extends string>({
  items,
  value,
  onChange,
}: {
  items: ReadonlyArray<{ id: Id; label: string }>;
  value: Id;
  onChange: (id: Id) => void;
}) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        minHeight: 36,
        padding: 2,
        borderRadius: radius.sm + 2,
        backgroundColor: t.field,
      }}
    >
      {items.map((item) => (
        <Segment
          key={item.id}
          label={item.label}
          selected={item.id === value}
          onPress={() => onChange(item.id)}
        />
      ))}
    </View>
  );
}
