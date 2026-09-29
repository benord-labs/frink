import { memo } from 'react';
import { Trash2 } from 'lucide-react-native';
import type { MobileChatSummary } from '../../../../src/shared/types/remote/mobile';
import { shortAge } from '../../lib/status';
import { KindTile } from '../../ui/glyphs';
import { ListRow } from '../../ui/list';
import { SwipeAction } from '../../ui/swipe-action';
import { Text } from '../../ui/text';
import { useTheme } from '../../ui/theme';
import { chatSubtitle } from './chat-sections';

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

/** Tile · name over kind and project, and one right-hand slot for state, else how long ago. */
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
  const title = chat.name || 'Untitled chat';
  return (
    <SwipeAction
      label="Delete"
      icon={Trash2}
      accessibilityLabel={`Delete ${title}`}
      onPress={() => onDelete(chat)}
    >
      <ListRow
        testID={`chat-row-${chat.id}`}
        leading={
          <KindTile kind={chat.kind} pulse={chat.activity === 'running' ? t.accent : undefined} />
        }
        title={title}
        subtitle={chatSubtitle(chat)}
        trailing={<Trailing chat={chat} />}
        onPress={() => onOpen(chat)}
      />
    </SwipeAction>
  );
});
