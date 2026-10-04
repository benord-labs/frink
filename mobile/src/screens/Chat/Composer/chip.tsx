import { Pressable } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { Text } from '../../../ui/text';
import { useTheme } from '../../../ui/theme';

/** A word and a caret: the quiet control for one choice in or under the message box. */
export function ChipButton({
  label,
  accessibilityLabel,
  disabled = false,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8 }}
      style={({ pressed }) => ({
        minHeight: 28,
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
      })}
    >
      <Text
        variant="secondary"
        color="secondary"
        numberOfLines={1}
        style={{ flexShrink: 1, fontWeight: '500' }}
      >
        {label}
      </Text>
      <ChevronDown size={13} color={t.muted} strokeWidth={2.2} />
    </Pressable>
  );
}
