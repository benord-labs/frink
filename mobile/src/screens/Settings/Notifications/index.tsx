import { Linking, Platform, View } from 'react-native';
import { useLiveActivity } from '../../../lib/live-activity';
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
      {denied && Platform.OS !== 'web' && <OpenSettings />}
      <LockScreen />
    </View>
  );
}

/** The Lock Screen card's switch, only where there is one (not on iPad or in a browser). */
function LockScreen() {
  const live = useLiveActivity();
  if (!live) return null;
  return (
    <View style={{ gap: space.sm, paddingTop: space.md }}>
      <ListRow
        title="Show on Lock Screen"
        subtitle="What’s running and what needs you"
        trailing={
          <Switch
            accessibilityLabel="Show on Lock Screen"
            value={live.on}
            onValueChange={live.set}
          />
        }
      />
      <Text variant="secondary" color="muted" style={{ paddingHorizontal: GUTTER }}>
        {live.refused
          ? 'Live Activities are off for Frink in iPhone Settings.'
          : 'Shows only numbers, never what your chats say. It appears the next time you open Frink while something is running.'}
      </Text>
      {live.refused && <OpenSettings />}
    </View>
  );
}

function OpenSettings() {
  return (
    <Button
      variant="plain"
      small
      style={{ alignSelf: 'flex-start' }}
      onPress={() => void Linking.openSettings()}
    >
      Open Settings
    </Button>
  );
}
