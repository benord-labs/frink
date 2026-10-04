import { memo } from 'react';
import { Trash2 } from 'lucide-react-native';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { shortAge } from '../../lib/status';
import { ListRow } from '../../ui/list';
import { SwipeAction } from '../../ui/swipe-action';
import { Text } from '../../ui/text';

/** The right-hand slot: only Running is coloured; Background is parked work, so it stays calm. */
function Trailing({ chat }: { chat: MobileChatSummary }) {
  if (chat.activity === 'running')
    return (
      <Text variant="secondary" color="accent" style={{ fontWeight: '600' }}>
        Running
      </Text>
    );
  return (
    <Text variant="secondary" color={chat.activity === 'background' ? 'secondary' : 'muted'}>
      {chat.activity === 'background' ? 'Background' : shortAge(chat.lastActiveAt)}
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
      <ListRow
        compact
        testID={`chat-row-${chat.id}`}
        accessibilityLabel={[title, chat.kind === 'flow' ? 'Flow' : '', chat.activity]
          .filter(Boolean)
          .join(', ')}
        title={title}
        trailing={<Trailing chat={chat} />}
        onPress={() => onOpen(chat)}
      />
    </SwipeAction>
  );
});
