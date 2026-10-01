import { useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Text } from './text';
import { useTheme } from './theme';

const ACTION_WIDTH = 84;
// Solid fills with a white label in both appearances, like Mail. The theme's state colours are
// tuned for text, and in dark mode they are pale tints that would need a dark label.
const FILLS = {
  destructive: { light: '#DC2828', dark: '#E5484D' },
  confirm: { light: '#15803D', dark: '#15803D' },
  primary: { light: '#7C3AED', dark: '#7C3AED' },
} as const;

export type SwipeActionItem = {
  label: string;
  icon: LucideIcon;
  fill: keyof typeof FILLS;
  accessibilityLabel: string;
  onPress: () => void;
};

/** A row that swipes left to reveal its actions, like iOS Mail. A horizontal scroll view does the
 *  gesture, so it needs no native gesture library and works in the web preview. */
export function SwipeAction({
  children,
  actions,
}: {
  children: ReactNode;
  actions: SwipeActionItem[];
}) {
  const t = useTheme();
  const scroll = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const measure = (next: number) => {
    if (next !== width) setWidth(next);
  };
  if (!actions.length) return children;
  // The row needs its own width before it can sit beside the hidden actions.
  if (!width)
    return <View onLayout={(event) => measure(event.nativeEvent.layout.width)}>{children}</View>;
  return (
    <View onLayout={(event) => measure(event.nativeEvent.layout.width)}>
      <ScrollView
        ref={scroll}
        horizontal
        bounces={false}
        showsHorizontalScrollIndicator={false}
        snapToOffsets={[0, ACTION_WIDTH * actions.length]}
        snapToEnd={false}
        decelerationRate="fast"
      >
        <View style={{ width }}>{children}</View>
        {actions.map(({ label, icon: Icon, fill, accessibilityLabel, onPress }) => (
          <Pressable
            key={label}
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
              paddingHorizontal: 4,
              backgroundColor: FILLS[fill][t.dark ? 'dark' : 'light'],
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Icon size={20} color="#FFFFFF" strokeWidth={2.2} />
            <Text
              variant="label"
              numberOfLines={2}
              style={{ color: '#FFFFFF', textAlign: 'center' }}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
