import { useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Text } from './text';
import { useTheme } from './theme';

const ACTION_WIDTH = 84;
// A solid red with a white label in both appearances, like Mail. The theme's `danger` is tuned
// for text, and in dark mode it is a pale pink that would need a dark label.
const DESTRUCTIVE_FILL = { light: '#DC2828', dark: '#E5484D' } as const;

/** A row that swipes left to reveal one destructive action, like iOS Mail. A horizontal scroll
 *  view does the gesture, so it needs no native gesture library and works in the web preview. */
export function SwipeAction({
  children,
  label,
  icon: Icon,
  accessibilityLabel,
  onPress,
}: {
  children: ReactNode;
  label: string;
  icon: LucideIcon;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const scroll = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const measure = (next: number) => {
    if (next !== width) setWidth(next);
  };
  // The row needs its own width before it can sit beside the hidden action.
  if (!width)
    return <View onLayout={(event) => measure(event.nativeEvent.layout.width)}>{children}</View>;
  return (
    <View onLayout={(event) => measure(event.nativeEvent.layout.width)}>
      <ScrollView
        ref={scroll}
        horizontal
        bounces={false}
        showsHorizontalScrollIndicator={false}
        snapToOffsets={[0, ACTION_WIDTH]}
        snapToEnd={false}
        decelerationRate="fast"
      >
        <View style={{ width }}>{children}</View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={() => {
            scroll.current?.scrollTo({ x: 0, animated: true });
            onPress();
          }}
          style={({ pressed }) => ({
            width: ACTION_WIDTH,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            backgroundColor: DESTRUCTIVE_FILL[t.dark ? 'dark' : 'light'],
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Icon size={20} color="#FFFFFF" strokeWidth={2.2} />
          <Text variant="label" style={{ color: '#FFFFFF' }}>
            {label}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
