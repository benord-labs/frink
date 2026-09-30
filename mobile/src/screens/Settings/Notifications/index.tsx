import { Linking, Platform, View } from 'react-native';
import { useLiveActivity } from '../../../lib/live-activity';
import { useNotifications } from '../../../lib/notifications';
import { Button } from '../../../ui/button';
import { ListRow, RowSeparator } from '../../../ui/list';
import { Switch } from '../../../ui/switch';
import { Text } from '../../../ui/text';
import { GUTTER, space } from '../../../ui/theme';
import { notificationsNote } from '../settings-view';
import { Card } from '../card';

/** Two switches, alerts and the Lock Screen card, with one line that says what leaves the Mac. */
export function Notifications() {
  const alerts = useNotifications();
  // Null on iPad and in a browser, where there is no Lock Screen card to offer.
  const live = useLiveActivity();
  const note = notificationsNote({
    denied: alerts.denied,
    refused: live?.refused ?? false,
    error: alerts.error,
  });
  return (
    <View style={{ gap: space.sm }}>
      <Card>
        <ListRow
          title="Alerts"
          trailing={
            <Switch
              accessibilityLabel="Alerts"
              value={alerts.enabled}
              disabled={alerts.busy}
              onValueChange={alerts.set}
            />
          }
        />
        {live && (
          <>
            <RowSeparator inset={GUTTER} />
            <ListRow
              title="Lock Screen"
              trailing={
                <Switch accessibilityLabel="Lock Screen" value={live.on} onValueChange={live.set} />
              }
            />
          </>
        )}
      </Card>
      <Text variant="secondary" color={note.tone} style={{ paddingHorizontal: GUTTER * 2 }}>
        {note.text}
      </Text>
      {note.openSettings && Platform.OS !== 'web' && (
        <Button
          variant="plain"
          small
          style={{ alignSelf: 'flex-start', marginLeft: GUTTER }}
          onPress={() => void Linking.openSettings()}
        >
          Open Settings
        </Button>
      )}
    </View>
  );
}
