import { Keyboard, Pressable } from 'react-native';
import { useConnection } from '../lib/connection';
import { useOverview } from '../lib/overview';
import { computerStatus } from '../screens/Settings/settings-view';
import { StatusDot } from '../ui/glyphs';
import { Text } from '../ui/text';
import { useRootNavigation } from './routes';

/** The computer on screen and how it is doing; opens Settings as a sheet. */
export function ComputerButton() {
  const navigation = useRootNavigation();
  const overview = useOverview();
  const { connection } = useConnection();
  const name = overview.data?.machineName ?? connection?.machineName ?? 'Your computer';
  const status = computerStatus(overview);
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
      <StatusDot tone={status.tone} />
      <Text variant="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
        {name}
      </Text>
    </Pressable>
  );
}
