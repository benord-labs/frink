import type { ReactNode } from 'react';
import { View } from 'react-native';
import { CircleAlert, Info, type LucideIcon } from 'lucide-react-native';
import { Text } from '../../ui/text';
import { space, useTheme } from '../../ui/theme';

/** One plain sentence with a glyph: an explanation (muted) or a failure (red). */
export function Note({
  children,
  error = false,
  icon,
}: {
  children: ReactNode;
  error?: boolean;
  icon?: LucideIcon;
}) {
  const t = useTheme();
  const Icon = icon ?? (error ? CircleAlert : Info);
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon size={16} color={error ? t.danger : t.muted} strokeWidth={2} />
      </View>
      <Text variant="secondary" color={error ? 'danger' : 'secondary'} style={{ flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}
