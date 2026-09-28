import { Pressable, Text, View } from 'react-native';
import { useTheme } from './theme';

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
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: selected ? t.raised : 'transparent',
        boxShadow: selected ? '0 1px 3px rgba(0,0,0,0.18)' : undefined,
      }}
    >
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.6}
        style={{
          fontSize: 14,
          lineHeight: 18,
          fontWeight: selected ? '600' : '500',
          color: selected ? t.text : t.secondary,
        }}
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
        borderRadius: 10,
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
