import type { MobileTextRun } from '@frink/shared/types/remote/mobile';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Platform, View } from 'react-native';
import { Text } from '../../../ui/text';
import { useTheme, type TypeVariant } from '../../../ui/theme';
import { MentionIcon } from './mention-icon';

// iOS sets an inline view's bottom on the baseline; this lowers the badge so its name sits on it.
const BADGE_NUDGE = Platform.select({ ios: 4, default: 0 });

/** A name as the desktop's mention badge: its icon and name on a tinted fill, inside the line. */
function MentionBadge({
  kind,
  name,
}: {
  kind: NonNullable<MobileTextRun['mention']>;
  name: string;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        maxWidth: 220,
        paddingHorizontal: 6,
        borderRadius: 6,
        backgroundColor: t.accentSoft,
        transform: [{ translateY: BADGE_NUDGE }],
      }}
    >
      <MentionIcon kind={kind} name={name} />
      <Text variant="secondary" numberOfLines={1} style={{ flexShrink: 1, fontWeight: '500' }}>
        {name}
      </Text>
    </View>
  );
}

function copyPlain(text: string) {
  void Clipboard.setStringAsync(text)
    .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
    .catch(() => {});
}

/** The user's words with badges where the runs mark names. iOS reads and copies a badge as an empty
 * box, so there the text is spoken and copied plain: a long press copies it. */
export function MentionText({
  text,
  runs,
  variant,
}: {
  text: string;
  runs?: MobileTextRun[];
  variant?: TypeVariant;
}) {
  if (!runs?.some((run) => run.mention))
    return (
      <Text variant={variant} selectable>
        {text}
      </Text>
    );
  const ios = Platform.OS === 'ios';
  return (
    <Text
      variant={variant}
      accessibilityLabel={text}
      selectable={!ios}
      onLongPress={ios ? () => copyPlain(text) : undefined}
    >
      {runs.map(({ text: name, mention }, index) =>
        mention ? <MentionBadge key={`${index}-${name}`} kind={mention} name={name} /> : name,
      )}
    </Text>
  );
}
