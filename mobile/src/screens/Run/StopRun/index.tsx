import { useState } from 'react';
import { View } from 'react-native';
import { CircleStop } from 'lucide-react-native';
import { Button } from '../../../ui/button';
import { Text } from '../../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../../ui/theme';

/** Stopping can't be undone, so it asks once, in place, before calling `onStop`. */
export function StopRun({
  busy,
  error,
  onStop,
}: {
  busy: boolean;
  error: string | null;
  onStop: () => Promise<boolean>;
}) {
  const t = useTheme();
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <View style={{ paddingHorizontal: GUTTER, gap: space.sm }}>
        <Button variant="destructive" icon={CircleStop} onPress={() => setConfirming(true)}>
          Stop run
        </Button>
        {error && (
          <Text variant="secondary" color="danger" style={{ textAlign: 'center' }}>
            {error}
          </Text>
        )}
      </View>
    );
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        marginHorizontal: GUTTER,
        padding: space.lg,
        gap: space.md,
        borderRadius: radius.lg,
        backgroundColor: t.fill,
      }}
    >
      <View style={{ gap: 2 }}>
        <Text variant="headline">Stop this run?</Text>
        <Text variant="secondary" color="secondary">
          Steps that haven’t finished won’t run. You can start the Flow again later.
        </Text>
        {error && (
          <Text variant="secondary" color="danger">
            {error}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button variant="secondary" style={{ flex: 1 }} onPress={() => setConfirming(false)}>
          Keep running
        </Button>
        <Button
          variant="destructive"
          style={{ flex: 1 }}
          busy={busy}
          accessibilityLabel="Stop run now"
          onPress={async () => {
            if (await onStop()) setConfirming(false);
          }}
        >
          Stop run
        </Button>
      </View>
    </View>
  );
}
