import { View } from 'react-native';
import { Check, Inbox, MonitorOff, Play, RotateCcw } from 'lucide-react-native';
import type { MobileTaskAction } from '@frink/shared/types/remote/mobile';
import { shortAge } from '../../lib/status';
import { KindTile, PulseDot, toneColor } from '../../ui/glyphs';
import { ListRow } from '../../ui/list';
import { SwipeAction, type SwipeActionItem } from '../../ui/swipe-action';
import { Text } from '../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../ui/theme';
import type { QueueRow } from './queue-view';

const TILE = 38;

/** The desktop Work Queue's labels, so a task reads the same on both. */
export const ACTION_ITEMS: Record<MobileTaskAction, Pick<SwipeActionItem, 'label' | 'icon' | 'fill'>> = {
  startTask: { label: 'Start task', icon: Play, fill: 'primary' },
  continueTask: { label: 'Carry on task', icon: RotateCcw, fill: 'primary' },
  completeTask: { label: 'Mark complete', icon: Check, fill: 'confirm' },
};

/** Work that isn't a chat or a Flow yet (an inbox item waiting to start). */
function InboxTile() {
  const t = useTheme();
  return (
    <View
      style={{
        width: TILE,
        height: TILE,
        borderRadius: radius.md,
        backgroundColor: t.fill,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Inbox size={TILE * 0.47} color={t.secondary} strokeWidth={1.9} />
    </View>
  );
}

/** The fixed right slot: the state in its colour over how long ago it last changed. */
function StatusSlot({ row }: { row: QueueRow }) {
  const t = useTheme();
  const color = toneColor(t, row.status.tone);
  const live = row.status.glyph === 'live';
  const age = shortAge(row.activityAt);
  return (
    <View style={{ minWidth: 64, maxWidth: 120, alignItems: 'flex-end', gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {live && <PulseDot color={color} size={7} />}
        <Text variant="secondary" numberOfLines={1} style={{ color, fontWeight: '600', lineHeight: 21 }}>
          {row.status.word}
        </Text>
      </View>
      {!!age && (
        <Text variant="secondary" color="muted" numberOfLines={1}>
          {age}
        </Text>
      )}
    </View>
  );
}

export function QueueListRow({
  row,
  onOpen,
  onAction,
}: {
  row: QueueRow;
  onOpen?: () => void;
  onAction: (action: MobileTaskAction) => void;
}) {
  const actions = row.actions.map((action) => ({
    ...ACTION_ITEMS[action],
    accessibilityLabel: `${ACTION_ITEMS[action].label}: ${row.title}`,
    onPress: () => onAction(action),
  }));
  return (
    <SwipeAction actions={actions}>
      <ListRow
        titleLines={row.emphasis ? 2 : 1}
        testID={`queue-row-${row.key}`}
        leading={row.kind === 'inbox' ? <InboxTile /> : <KindTile kind={row.kind} size={TILE} />}
        title={row.title}
        subtitle={row.detail}
        trailing={<StatusSlot row={row} />}
        onPress={onOpen}
      />
    </SwipeAction>
  );
}

/** Calm, not alarming: the phone still reads everything, it just can't start work. */
export function NotReadyNotice() {
  const t = useTheme();
  return (
    <View
      style={{
        marginHorizontal: GUTTER,
        marginTop: space.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        padding: space.lg,
        borderRadius: radius.lg,
        backgroundColor: t.fill,
      }}
    >
      <MonitorOff size={20} color={t.muted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="secondary" style={{ fontWeight: '600' }}>
          Open Frink on your Mac to run chats
        </Text>
        <Text variant="secondary" color="muted">
          You can still see everything here. New work starts once Frink is open.
        </Text>
      </View>
    </View>
  );
}

/** "Benji's MacBook Pro" with a dot: green while the Mac answers, grey while it doesn't. */
export function MacEyebrow({ name, online }: { name: string; online: boolean }) {
  const t = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${name}, ${online ? 'connected' : 'not reachable'}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <View
        style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? t.live : t.offline }}
      />
      <Text variant="label" color="muted" numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}
