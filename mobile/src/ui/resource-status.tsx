import { Pressable, View } from 'react-native';
import { Card, Icon, Label } from './primitives';
import { useTheme } from './theme';

// A lost connection with earlier data reads as waiting; a server error names what failed.
function statusCopy(error: string, errorStatus: number | undefined, time: string | null) {
  if (errorStatus !== 0) return { title: 'Couldn’t refresh', detail: error };
  if (!time) return { title: 'Couldn’t connect', detail: error };
  return { title: 'Waiting for your computer', detail: `Showing the last update from ${time}.` };
}

// Reason: Offline, stale and retry states share one banner.
// fallow-ignore-next-line complexity
export function ResourceStatus({
  error,
  errorStatus,
  updatedAt,
  refreshing,
  refresh,
}: {
  error?: string;
  errorStatus?: number;
  updatedAt?: number;
  refreshing?: boolean;
  refresh: () => void;
}) {
  const t = useTheme();
  if (!error) return null;
  const time = updatedAt
    ? new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  const copy = statusCopy(error, errorStatus, time);
  return (
    <Card>
      <View
        accessibilityLiveRegion="polite"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14 }}
      >
        <Icon name="cloud-offline-outline" size={20} color={t.warning} />
        <View style={{ flex: 1, gap: 2, paddingVertical: 12 }}>
          <Label size={15} bold>
            {copy.title}
          </Label>
          <Label muted size={14}>
            {copy.detail}
          </Label>
          {!!time && errorStatus !== 0 && (
            <Label muted size={12}>
              Last updated at {time}.
            </Label>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try refreshing again"
          accessibilityState={{ disabled: refreshing }}
          disabled={refreshing}
          onPress={refresh}
          style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="refresh" size={20} color={t.accent} />
        </Pressable>
      </View>
    </Card>
  );
}
