import { useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Icon, type IconName } from './primitives';
import { useTheme } from './theme';

const ACTION_WIDTH = 88;

/** A row that swipes left to reveal one destructive action, like iOS Mail. A horizontal scroll
 *  view does the gesture, so it needs no native gesture library and works in the web preview. */
export function SwipeAction({
  children,
  label,
  icon,
  accessibilityLabel,
  onPress,
}: {
  children: ReactNode;
  label: string;
  icon: IconName;
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
            backgroundColor: t.danger,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Icon name={icon} size={20} color={t.background} />
          <Text style={{ fontSize: 13, lineHeight: 16, fontWeight: '600', color: t.background }}>
            {label}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
