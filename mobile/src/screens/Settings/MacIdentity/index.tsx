import { View } from 'react-native';
import { Laptop } from 'lucide-react-native';
import { toneColor } from '../../../ui/glyphs';
import { Text } from '../../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../../ui/theme';
import type { MacStatus } from '../settings-view';

/** The paired Mac at a glance: who it is, whether it answers, and what to do when it doesn't. */
export function MacIdentity({ name, status }: { name: string; status: MacStatus }) {
  const t = useTheme();
  return (
    <View
      testID="mac-identity"
      style={{
        flexDirection: 'row',
        gap: space.lg,
        paddingHorizontal: GUTTER,
        paddingTop: space.lg,
        alignItems: status.detail ? 'flex-start' : 'center',
      }}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: radius.lg,
          backgroundColor: t.fill,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Laptop size={26} color={t.text} strokeWidth={1.8} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: space.xs, paddingTop: status.detail ? 3 : 0 }}>
        <Text variant="headline" numberOfLines={1}>
          {name}
        </Text>
        <View
          accessibilityLiveRegion="polite"
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: toneColor(t, status.tone),
            }}
          />
          <Text variant="secondary" color="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
            {status.label}
          </Text>
        </View>
        {status.detail && (
          <Text variant="secondary" color="muted">
            {status.detail}
          </Text>
        )}
      </View>
    </View>
  );
}
