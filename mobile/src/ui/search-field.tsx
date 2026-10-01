import { Pressable, TextInput, View, type TextStyle } from 'react-native';
import { CircleX, Search } from 'lucide-react-native';
import { radius, useTheme } from './theme';

// Web draws a focus ring inside borderless inputs that already sit in a styled frame.
export const bareInput = { outlineStyle: 'none' } as unknown as TextStyle;

/** In-content search, used where iOS's native header search bar is not available (web). */
export function SearchField({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 40,
        gap: 8,
        backgroundColor: t.field,
        borderRadius: radius.md,
        paddingLeft: 12,
      }}
    >
      <Search size={17} color={t.muted} />
      <TextInput
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={t.muted}
        selectionColor={t.accent}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[{ flex: 1, minHeight: 40, padding: 0, fontSize: 16, color: t.text }, bareInput]}
      />
      {!!value && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChangeText('')}
          style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
        >
          <CircleX size={17} color={t.muted} />
        </Pressable>
      )}
    </View>
  );
}
