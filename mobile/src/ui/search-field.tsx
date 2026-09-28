import { Pressable, TextInput, View } from 'react-native';
import { Icon, bareInput } from './primitives';
import { useTheme } from './theme';

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
        borderRadius: 12,
        paddingLeft: 12,
      }}
    >
      <Icon name="search" size={17} color={t.muted} />
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
        style={[
          { flex: 1, minHeight: 40, padding: 0, fontSize: 16, color: t.text },
          bareInput,
        ]}
      />
      {!!value && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChangeText('')}
          style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="close-circle" size={17} color={t.muted} />
        </Pressable>
      )}
    </View>
  );
}
