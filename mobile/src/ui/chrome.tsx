import { BlurView } from 'expo-blur';
import { StyleSheet, View, useColorScheme } from 'react-native';
import { useTheme } from './theme';

export function Chrome() {
  const t = useTheme();
  const scheme = useColorScheme();
  if (t.solid)
    return (
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: t.solidSurface }]}
      />
    );
  return (
    <BlurView
      pointerEvents="none"
      tint={scheme === 'light' ? 'light' : 'dark'}
      intensity={65}
      style={[StyleSheet.absoluteFill, { backgroundColor: t.surface }]}
    />
  );
}
