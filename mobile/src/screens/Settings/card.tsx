import type { ReactNode } from 'react';
import { View } from 'react-native';
import { GUTTER, radius, useTheme } from '../../ui/theme';

/** A framed group of one-line rows, inset from the screen edges like iOS Settings. */
export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      style={{
        marginHorizontal: GUTTER,
        borderRadius: radius.lg,
        backgroundColor: t.fill,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}
