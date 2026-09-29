import { Text as NativeText, type StyleProp, type TextProps, type TextStyle } from 'react-native';
import { type as ramp, useTheme, type TypeVariant } from './theme';

type Color = 'text' | 'secondary' | 'muted' | 'accent' | 'live' | 'attention' | 'danger';

/** Every string in the app goes through here, so sizes stay on the ramp (no 13, 11 or 10pt). */
export function Text({
  variant = 'body',
  color = 'text',
  style,
  ...props
}: TextProps & { variant?: TypeVariant; color?: Color; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <NativeText
      maxFontSizeMultiplier={1.6}
      {...props}
      style={[ramp[variant], { color: t[color] }, style]}
    />
  );
}

