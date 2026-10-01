import { Pressable, View } from 'react-native';
import { CloudOff, RefreshCw } from 'lucide-react-native';
import { Text } from './text';
import { GUTTER, radius, space, useTheme } from './theme';

// A lost connection with earlier data reads as waiting; a server error names what failed.
function statusCopy(error: string, errorStatus: number | undefined, time: string | null) {
  if (errorStatus !== 0) return { title: 'Couldn’t refresh', detail: error };
  if (!time) return { title: 'Can’t reach your Mac', detail: error };
  return { title: 'Can’t reach your Mac', detail: `Showing what it sent at ${time}.` };
}

/** Offline / failed-refresh banner for the top of any screen. Renders nothing when healthy. */
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
    <View
      accessibilityLiveRegion="polite"
      style={{
        marginHorizontal: GUTTER,
        marginTop: space.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingLeft: space.lg,
        borderRadius: radius.lg,
        backgroundColor: t.attentionSoft,
      }}
    >
      <CloudOff size={20} color={t.attention} />
      <View style={{ flex: 1, gap: 2, paddingVertical: space.md }}>
        <Text variant="secondary" style={{ fontWeight: '600' }}>
          {copy.title}
        </Text>
        <Text variant="secondary" color="secondary">
          {copy.detail}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try again"
        accessibilityState={{ disabled: refreshing }}
        disabled={refreshing}
        onPress={refresh}
        style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}
      >
        <RefreshCw size={19} color={t.text} />
      </Pressable>
    </View>
  );
}
