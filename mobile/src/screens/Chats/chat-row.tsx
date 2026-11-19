import { memo } from 'react';
import { Pressable, useWindowDimensions } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { shortAge } from '../../lib/status';
import { SwipeAction } from '../../ui/swipe-action';
import { Text } from '../../ui/text';
import { radius, useTheme } from '../../ui/theme';

/** Running is coloured; parked work and last activity remain quiet supporting context. */
// Reason: Chat states have browser tests; CRAP estimates zero without their coverage map.
// fallow-ignore-next-line complexity
function Trailing({ chat }: { chat: MobileChatSummary }) {
  const status =
    chat.activity === 'running'
      ? 'Running'
      : chat.activity === 'background'
        ? 'Background'
        : shortAge(chat.lastActiveAt);
  return (
    <Text variant="secondary" color={chat.activity === 'running' ? 'accent' : 'muted'}>
      {[chat.projectName, chat.kind === 'flow' ? 'Flow' : '', status].filter(Boolean).join(' · ')}
    </Text>
  );
}

export const ChatRow = memo(function ChatRow({
  chat,
  onOpen,
  onDelete,
}: {
  chat: MobileChatSummary;
  onOpen: (chat: MobileChatSummary) => void;
  onDelete: (chat: MobileChatSummary) => void;
}) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const title = chat.name || 'Untitled chat';
  return (
    <SwipeAction
      actions={[
        {
          label: 'Delete',
          icon: Trash2,
          fill: 'destructive',
          accessibilityLabel: `Delete ${title}`,
          onPress: () => onDelete(chat),
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        testID={`chat-row-${chat.id}`}
        accessibilityLabel={[title, chat.kind === 'flow' ? 'Flow' : '', chat.activity]
          .filter(Boolean)
          .join(', ')}
        onPress={() => onOpen(chat)}
        style={({ pressed }) => ({
          minHeight: 64,
          paddingHorizontal: 10,
          paddingVertical: 10,
          gap: 3,
          borderRadius: radius.md,
          backgroundColor: pressed ? t.pressed : 'transparent',
        })}
      >
        <Text variant="row" numberOfLines={fontScale > 1.2 ? undefined : 2}>
          {title}
        </Text>
        <Trailing chat={chat} />
      </Pressable>
    </SwipeAction>
  );
});
