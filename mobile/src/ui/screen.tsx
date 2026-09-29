import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Atmosphere } from './material';
import { useTheme } from './theme';

/** Every routed screen: the flat page, or the atmosphere for chat and settings. */
export function Screen({
  children,
  atmosphere = false,
}: {
  children: ReactNode;
  atmosphere?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      {atmosphere && <Atmosphere />}
      {children}
    </View>
  );
}
