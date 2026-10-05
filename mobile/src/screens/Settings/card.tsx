import type { ReactNode } from 'react';
import { View } from 'react-native';
import { glassLighting } from '../../ui/material';
import { GUTTER, radius, useTheme } from '../../ui/theme';

export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      style={{
        marginHorizontal: GUTTER,
        borderRadius: radius.lg,
        overflow: 'hidden',
        backgroundColor: t.surface,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        ...glassLighting(t),
      }}
    >
      {children}
    </View>
  );
}
