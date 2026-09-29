import { useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, View } from 'react-native';
import { CircleCheck } from 'lucide-react-native';
import { useConnection, useResource } from '../../lib/connection';
import { useOverview } from '../../lib/overview';
import { useRootNavigation } from '../../navigation/routes';
import { useTabHeader } from '../../navigation/tab-header';
import { EmptyState, RowSeparator, SectionHeader } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { space, useTheme } from '../../ui/theme';
import {
  COLLAPSED_ROWS,
  expandedLimits,
  queueSections,
  type QueueSection,
  type QueueSectionKey,
  type QueueTarget,
} from './queue-view';
import { MacEyebrow, NotReadyNotice, QueueListRow } from './row';

/**
 * The shared overview poll serves the collapsed Queue (and the tab badge). Once a section is
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
  const resource = grown ? { ...own, data: own.stale ? shared.data : (own.data ?? shared.data) } : shared;
  const sections = resource.data ? queueSections(resource.data) : [];
  const toggle = (key: QueueSectionKey) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };
  return { resource, sections, expanded, toggle };
}

export function QueueScreen() {
  const t = useTheme();
  const navigation = useRootNavigation();
  const { connection } = useConnection();
  const { resource, sections, expanded, toggle } = useQueueOverview();
  const { data, error } = resource;
  const { header } = useTabHeader({
    title: 'Queue',
    eyebrow: (
      <MacEyebrow
        name={data?.machineName ?? connection?.machineName ?? 'Your Mac'}
        online={!!data && !error}
      />
    ),
    compose: true,
    composeDisabled: data?.executionReady === false,
  });
  const open = (target: QueueTarget) =>
    target.screen === 'Run'
      ? navigation.navigate('Run', { id: target.id })
      : navigation.navigate('Chat', {
          id: target.id,
          subChatId: target.subChatId,
          decisionTarget: target.decisionTarget,
        });
  const listSections = sections.map((section) => ({
    ...section,
    data: expanded.has(section.key) ? section.rows : section.rows.slice(0, COLLAPSED_ROWS),
  }));
  return (
    <Screen>
      <SectionList
        sections={listSections}
        keyExtractor={(row) => row.key}
        contentInsetAdjustmentBehavior="automatic"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl
            refreshing={resource.refreshing}
            onRefresh={resource.pull}
            tintColor={t.muted}
          />
        }
        ListHeaderComponent={
          <View>
            {header}
            <ResourceStatus {...resource} refresh={resource.pull} />
            {data && !data.executionReady && <NotReadyNotice />}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <SectionHeader
            title={section.title}
            count={section.total}
            action={sectionAction(section, expanded.has(section.key))}
            onAction={() => toggle(section.key)}
          />
        )}
        renderItem={({ item }) => (
          <QueueListRow row={item} onOpen={item.target ? () => open(item.target!) : undefined} />
        )}
        ItemSeparatorComponent={() => <RowSeparator />}
        ListEmptyComponent={
          data ? (
            <EmptyState
              icon={CircleCheck}
              title="You’re all caught up"
              detail="Questions, approvals and finished work from your Mac will show up here."
            />
          ) : error ? null : (
            <ActivityIndicator color={t.muted} style={{ marginTop: space.xxl * 2 }} />
          )
        }
      />
    </Screen>
  );
}

function sectionAction(section: QueueSection, expanded: boolean) {
  if (expanded) return section.rows.length > COLLAPSED_ROWS ? 'Show less' : undefined;
  return section.hasMore ? 'Show all' : undefined;
}
