import { View } from 'react-native';
import { CircleAlert, Info } from 'lucide-react-native';
import { Text } from '../../ui/text';
import { radius, space, useTheme } from '../../ui/theme';

/** A short message under the chips. The icon carries the tone, so it reads without the tint. */
export function Note({
  tone,
  children,
  detail,
}: {
  tone: 'attention' | 'danger';
  children: string;
  detail?: string;
}) {
  const t = useTheme();
  const Icon = tone === 'danger' ? CircleAlert : Info;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        gap: space.sm + 2,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radius.lg,
        backgroundColor: tone === 'danger' ? t.dangerSoft : t.attentionSoft,
      }}
    >
      <Icon size={16} color={t[tone]} strokeWidth={2.2} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="secondary">{children}</Text>
        {!!detail && (
          <Text variant="secondary" color="muted">
            {detail}
          </Text>
        )}
      </View>
    </View>
  );
}
