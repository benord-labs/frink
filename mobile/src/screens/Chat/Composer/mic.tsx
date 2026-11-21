import { Animated, Pressable } from 'react-native';
import { Mic } from 'lucide-react-native';
import { useLoop } from '../../../ui/glyphs';
import { useTheme } from '../../../ui/theme';
import { ACTION } from './attach';

/** Starts and stops dictation; it pulses while the phone is listening. */
export function MicButton({
  listening,
  disabled,
  onPress,
}: {
  listening: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const pulse = useLoop(1200, listening);
  const opacity = listening
    ? pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.45, 1] })
    : 1;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={listening ? 'Stop dictation' : 'Dictate'}
      accessibilityState={{ disabled, selected: listening }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={5}
      style={({ pressed }) => ({
        width: ACTION,
        height: ACTION,
        borderRadius: ACTION / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: listening ? t.accent : t.fill,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Animated.View style={{ opacity }}>
        <Mic size={18} color={listening ? t.onAccent : t.text} strokeWidth={2.1} />
      </Animated.View>
    </Pressable>
  );
}
