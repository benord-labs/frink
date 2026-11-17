import {
  Text as NativeText,
  useWindowDimensions,
  type StyleProp,
  type TextProps,
  type TextStyle,
} from 'react-native';
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
  // Native text keeps its old measurements when the system text size changes; a new key remeasures.
  const { fontScale } = useWindowDimensions();
  return (
    <NativeText
      key={fontScale}
      maxFontSizeMultiplier={2}
      {...props}
      style={[ramp[variant], { color: t[color] }, style]}
    />
  );
}
