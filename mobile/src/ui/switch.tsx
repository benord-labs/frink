import { Platform, Switch as NativeSwitch, type SwitchProps } from 'react-native';
import { useTheme } from './theme';

/**
 * The app's on/off switch: accent track when on, white thumb on every platform. The off track is
 * iOS's own translucent systemFill grey, so it reads on the page and on a framed card alike.
 */
export function Switch(props: SwitchProps) {
  const t = useTheme();
  return (
    <NativeSwitch
      trackColor={{
        true: t.accent,
        false: t.dark ? 'rgba(120,120,128,0.36)' : 'rgba(120,120,128,0.2)',
      }}
      thumbColor="#FFFFFF"
      {...(Platform.OS === 'web' ? { activeThumbColor: '#FFFFFF' } : {})}
      {...props}
    />
  );
}
