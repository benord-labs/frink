import { useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { bareInput } from '../../../ui/search-field';
import { Text } from '../../../ui/text';
import { radius, space, type as ramp, useTheme } from '../../../ui/theme';

/** A labelled input: an outlined frame (no fill) that lights up in the brand colour while focused. */
export function Field({
  label,
  hint,
  mono = false,
  ...input
}: TextInputProps & { label: string; hint?: string; mono?: boolean }) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="label" color="muted">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        selectionColor={t.accent}
        maxFontSizeMultiplier={2}
        {...input}
        onFocus={(event) => {
          setFocused(true);
          input.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          input.onBlur?.(event);
        }}
        style={[
          mono ? ramp.mono : ramp.body,
          bareInput,
          {
            color: t.text,
            minHeight: 50,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: focused ? t.accent : t.border,
            backgroundColor: t.fill,
            textAlignVertical: 'top',
          },
          input.style,
        ]}
      />
      {hint && (
        <Text variant="secondary" color="muted">
          {hint}
        </Text>
      )}
    </View>
  );
}
