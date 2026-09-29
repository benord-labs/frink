import { Platform, Switch as NativeSwitch, type SwitchProps } from 'react-native';
import { useTheme } from './theme';

/** The app's on/off switch: accent track when on, white thumb on every platform. */
export function Switch(props: SwitchProps) {
  const t = useTheme();
  return (
    <NativeSwitch
      trackColor={{ true: t.accent, false: t.field }}
      thumbColor="#FFFFFF"
      {...(Platform.OS === 'web' ? { activeThumbColor: '#FFFFFF' } : {})}
      {...props}
    />
  );
}
