import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import type { MobileTaskAction } from '@frink/shared/types/remote/mobile';
import { useConnection, useResource } from '../../lib/connection';
import { useOverview } from '../../lib/overview';
import { useRootNavigation } from '../../navigation/routes';
import { useScreenHeader } from '../../navigation/screen-header';
import { EmptyState, ListGroup, SectionHeader } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { tell } from '../../ui/tell';
import { space, useTheme } from '../../ui/theme';
import {
  COLLAPSED_ROWS,
  expandedLimits,
  queueSections,
  type QueueSection,
  type QueueSectionKey,
  type QueueTarget,
} from './queue-view';
import { ACTION_ITEMS, MacEyebrow, NotReadyNotice, QueueListRow } from './row';

/**
 * The shared overview poll serves the collapsed Queue (and the Queue badge). Once a section is
 * expanded the Queue polls its own, larger overview, keeping the old rows while it loads.
 */
function useQueueOverview() {
  const shared = useOverview();
  const [expanded, setExpanded] = useState<Set<QueueSectionKey>>(new Set());
  // Derived each render from the shared poll's counts, so an expanded list follows the live total.
  const limits = shared.data ? expandedLimits(expanded, shared.data.counts) : {};
  const grown = Object.keys(limits).length > 0;
  const own = useResource({ type: 'overview', limits }, { enabled: grown, keep: true });
  // `keep` bridges a growing window; rows left from an earlier expansion are older than the shared poll.
  const resource = grown
    ? { ...own, data: own.stale ? shared.data : (own.data ?? shared.data) }
    : shared;
  const sections = resource.data ? queueSections(resource.data) : [];
  const toggle = (key: QueueSectionKey) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };
  return { resource, shared, grown, sections, expanded, toggle };
}

export function QueueScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const navigation = useRootNavigation();
  const { connection, request } = useConnection();
  const { resource, shared, grown, sections, expanded, toggle } = useQueueOverview();
  const { data, error } = resource;
  const { header } = useScreenHeader({
    title: 'Queue',
    eyebrow: (
      <MacEyebrow
        name={data?.machineName ?? connection?.machineName ?? 'Your Mac'}
        online={!!data && !error}
      />
    ),
  });
  const open = (target: QueueTarget) =>
    target.screen === 'Run'
      ? navigation.navigate('Run', { id: target.id })
      : navigation.navigate('Chat', {
          id: target.id,
          subChatId: target.subChatId,
          decisionTarget: target.decisionTarget,
        });
  // The computer re-checks each action, so a row that changed since the last poll says so.
  const act = async (id: string, action: MobileTaskAction) => {
    try {
      await request({ type: action, id });
    } catch (error) {
      tell(
        `Couldn’t ${ACTION_ITEMS[action].label.toLowerCase()}`,
        error instanceof Error ? error.message : '',
      );
    }
    resource.refresh();
    // The Queue badge counts from the shared poll, which an expanded Queue doesn't refresh.
    if (grown) shared.refresh();
  };
  return (
    <Screen atmosphere>
      <ScrollView
        testID="queue-screen"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
        refreshControl={
          <RefreshControl
            refreshing={resource.refreshing}
            onRefresh={resource.pull}
            tintColor={t.muted}
          />
        }
      >
        {header}
        <ResourceStatus {...resource} refresh={resource.pull} />
        {data && !data.executionReady && <NotReadyNotice />}
        {sections.map((section) => {
          const all = expanded.has(section.key);
          const rows = all ? section.rows : section.rows.slice(0, COLLAPSED_ROWS);
          return (
            <View key={section.key}>
              <SectionHeader
                title={section.title}
                count={section.total}
                action={sectionAction(section, all)}
                onAction={() => toggle(section.key)}
              />
              <ListGroup>
                {rows.map((row) => (
                  <QueueListRow
                    key={row.key}
                    row={row}
                    onOpen={row.target ? () => open(row.target!) : undefined}
                    onAction={(action) => void act(row.key, action)}
                  />
                ))}
              </ListGroup>
            </View>
          );
        })}
        {!sections.length &&
          (data ? (
            <EmptyState
              title="You’re all caught up"
              detail="Questions, approvals and finished work from your Mac will show up here."
            />
          ) : (
            !error && <ActivityIndicator color={t.muted} style={{ marginTop: space.xxl * 2 }} />
          ))}
      </ScrollView>
    </Screen>
  );
}

function sectionAction(section: QueueSection, expanded: boolean) {
  if (expanded) return section.rows.length > COLLAPSED_ROWS ? 'Show less' : undefined;
  return section.hasMore ? 'Show all' : undefined;
}
