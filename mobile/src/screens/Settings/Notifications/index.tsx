import { Linking, Platform, View } from 'react-native';
import { useNotifications } from '../../../lib/notifications';
import { Button } from '../../../ui/button';
import { ListRow } from '../../../ui/list';
import { Switch } from '../../../ui/switch';
import { Text } from '../../../ui/text';
import { GUTTER, space } from '../../../ui/theme';

/** One switch for "tell me when a chat finishes", with what leaves the Mac said plainly. */
export function Notifications() {
  const { enabled, busy, denied, error, set } = useNotifications();
  return (
    <View style={{ gap: space.sm }}>
      <ListRow
        title="When a chat finishes"
        subtitle="Alert this iPhone, even when it’s locked"
        trailing={
          <Switch
            accessibilityLabel="Alert me when a chat finishes"
            value={enabled}
            disabled={busy}
            onValueChange={set}
          />
        }
      />
      {error && (
        <Text variant="secondary" color="danger" style={{ paddingHorizontal: GUTTER }}>
          {error}
        </Text>
      )}
      <Text variant="secondary" color="muted" style={{ paddingHorizontal: GUTTER }}>
        {denied
          ? 'Alerts are off for Frink in iPhone Settings. Allow them there, then turn this on.'
          : 'Alerts only say a chat finished. Your prompts and code stay on your Mac.'}
      </Text>
      {denied && Platform.OS !== 'web' && (
        <Button
          variant="plain"
          small
          style={{ alignSelf: 'flex-start' }}
          onPress={() => void Linking.openSettings()}
        >
          Open Settings
        </Button>
      )}
    </View>
  );
}
