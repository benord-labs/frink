import { View } from 'react-native';
import { Check, MonitorOff, Play, RotateCcw } from 'lucide-react-native';
import type { RecoveryKind } from '@frink/shared/types/flow-run/resume';
import type { MobileTaskAction } from '@frink/shared/types/remote/mobile';
import { shortAge } from '../../lib/status';
import { PulseDot, toneColor } from '../../ui/glyphs';
import { ListRow } from '../../ui/list';
import { SwipeAction, type SwipeActionItem } from '../../ui/swipe-action';
import { Text } from '../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../ui/theme';
import type { QueueRow } from './queue-view';

type ActionItem = Pick<SwipeActionItem, 'label' | 'icon' | 'fill'>;

/** The desktop Work Queue's labels, so a task reads the same on both. */
const ACTION_ITEMS = {
  startTask: { label: 'Start task', icon: Play, fill: 'primary' },
  completeTask: { label: 'Mark complete', icon: Check, fill: 'confirm' },
} satisfies Record<Exclude<MobileTaskAction, 'continueTask'>, ActionItem>;
/** A stopped task's one recovery, as desktop's RecoveryMenuItem labels it. */
const RECOVERY_ITEMS = {
  continue: { label: 'Continue task', icon: Play, fill: 'primary' },
  retry: { label: 'Retry task', icon: RotateCcw, fill: 'primary' },
} satisfies Record<RecoveryKind, ActionItem>;

export function actionItem(action: MobileTaskAction, recoveryKind: RecoveryKind): ActionItem {
  return action === 'continueTask' ? RECOVERY_ITEMS[recoveryKind] : ACTION_ITEMS[action];
}

/** State and project details share a quiet line below the task's full-width title. */
function StatusSlot({ row }: { row: QueueRow }) {
  const t = useTheme();
  const color = toneColor(t, row.status.tone);
  const live = row.status.glyph === 'live';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {live && <PulseDot color={color} size={7} />}
      <Text variant="secondary" color="muted" style={{ flex: 1 }}>
        <Text variant="secondary" style={{ color }}>
          {row.status.word}
        </Text>
        {row.detail ? ` · ${row.detail}` : ''}
      </Text>
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
  const actions = row.actions.map((action) => {
    const item = actionItem(action, row.recoveryKind);
    return {
      ...item,
      accessibilityLabel: `${item.label}: ${row.title}`,
      onPress: () => onAction(action),
    };
  });
  return (
    <SwipeAction actions={actions}>
      <ListRow
        titleLines={row.emphasis ? 2 : 1}
        testID={`queue-row-${row.key}`}
        title={row.title}
        subtitle={<StatusSlot row={row} />}
        trailing={row.activityAt ? <Text variant="label" color="muted">{shortAge(row.activityAt)}</Text> : undefined}
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
