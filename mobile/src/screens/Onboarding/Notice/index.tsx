import { View } from 'react-native';
import { CircleAlert, type LucideIcon } from 'lucide-react-native';
import { Text } from '../../../ui/text';
import { radius, space, toneColors, useTheme } from '../../../ui/theme';

/** A plain-language problem: what happened on the first line, what to do on the second. */
export function Notice({
  title,
  detail,
  icon: Icon = CircleAlert,
  tone = 'danger',
}: {
  title: string;
  detail?: string;
  icon?: LucideIcon;
  /** Red for a failed action; amber for something the person needs to do next. */
  tone?: 'danger' | 'attention';
}) {
  const t = useTheme();
  const { fg, bg } = toneColors(t, tone);
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        gap: space.md,
        padding: space.lg,
        borderRadius: radius.lg,
        backgroundColor: bg,
      }}
    >
      <Icon size={20} color={fg} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="secondary" style={{ fontWeight: '600' }}>
          {title}
        </Text>
        {detail && (
          <Text variant="secondary" color="secondary">
            {detail}
          </Text>
        )}
      </View>
    </View>
  );
}
