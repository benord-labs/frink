import { Keyboard, Pressable, View } from 'react-native';
import { useConnection } from '../lib/connection';
import { useOverview } from '../lib/overview';
import { macStatus } from '../screens/Settings/settings-view';
import { Text } from '../ui/text';
import { useTheme } from '../ui/theme';
import { useRootNavigation } from './routes';

/** The computer on screen and how it is doing; opens Settings as a sheet. */
export function ComputerButton() {
  const t = useTheme();
  const navigation = useRootNavigation();
  const overview = useOverview();
  const { connection } = useConnection();
  const name = overview.data?.machineName ?? connection?.machineName ?? 'Your computer';
  const status = macStatus(overview);
  const tones = { live: t.live, attention: t.attention, quiet: t.muted };
  return (
    <Pressable
      testID="computer-button"
      accessibilityRole="button"
      accessibilityLabel={`Computer settings: ${name}, ${status.label}`}
      onPress={() => {
        Keyboard.dismiss();
        navigation.navigate('Settings');
      }}
      style={({ pressed }) => ({
        maxWidth: 150,
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tones[status.tone] }} />
      <Text variant="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
        {name}
      </Text>
    </Pressable>
  );
}
