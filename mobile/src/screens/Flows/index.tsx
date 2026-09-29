import { Fragment, useMemo } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView } from 'react-native';
import { Search, Workflow } from 'lucide-react-native';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { useResource } from '../../lib/connection';
import { useRootNavigation } from '../../navigation/routes';
import { useTabHeader } from '../../navigation/tab-header';
import { EmptyState, ListRow, RowSeparator, SectionHeader } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { useTheme } from '../../ui/theme';
import { TONE_TEXT } from '../Run/run-view';
import { flowSections, flowStatus, flowTrailing, type FlowSection } from './flow-list';
import { StatusTile } from './StatusTile';

function FlowRow({ flow, onPress }: { flow: MobileFlow; onPress: () => void }) {
  const status = flowStatus(flow);
  const trailing = flowTrailing(flow);
  return (
    <ListRow
      testID={`flow-row-${flow.id}`}
      accessibilityLabel={`${flow.name}, ${status.word}${flow.enabled ? '' : ', off'}`}
      leading={<StatusTile status={status} />}
      title={flow.name}
      subtitle={flow.description || undefined}
      dimmed={!flow.enabled}
      onPress={onPress}
      trailing={
        trailing && (
          <Text variant="secondary" color={TONE_TEXT[trailing.tone]}>
            {trailing.text}
          </Text>
        )
      }
    />
  );
}

function Sections({ sections }: { sections: FlowSection[] }) {
  const navigation = useRootNavigation();
  return sections.map((section) => (
    <Fragment key={section.id}>
      <SectionHeader title={section.title} count={section.flows.length} />
      {section.flows.map((flow, index) => (
        <Fragment key={flow.id}>
          {index > 0 && <RowSeparator />}
          <FlowRow flow={flow} onPress={() => navigation.navigate('Flow', { id: flow.id })} />
        </Fragment>
      ))}
    </Fragment>
  ));
}

/** The Flows tab: every Flow on the Mac, grouped the way the desktop list groups them. */
export function FlowsScreen() {
  const t = useTheme();
  const resource = useResource({ type: 'flows' }, { interval: 5000 });
  const { data, error, refreshing, pull } = resource;
  const { query, header } = useTabHeader({ title: 'Flows', search: 'Search flows' });
  const sections = useMemo(() => flowSections(data ?? [], query), [data, query]);
  return (
    <Screen>
      <ScrollView
        testID="flows-screen"
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} />}
      >
        {header}
        <ResourceStatus {...resource} />
        {!data ? (
          !error && <ActivityIndicator color={t.muted} style={{ marginTop: 64 }} />
        ) : !data.length ? (
          <EmptyState
            icon={Workflow}
            title="No Flows yet"
            detail="Flows are automations you build in Frink on your Mac. Once you make one, you can run it and follow it here."
          />
        ) : !sections.length ? (
          <EmptyState
            icon={Search}
            title={`No Flows match “${query}”`}
            detail="Try another name or description."
          />
        ) : (
          <Sections sections={sections} />
        )}
      </ScrollView>
    </Screen>
  );
}
