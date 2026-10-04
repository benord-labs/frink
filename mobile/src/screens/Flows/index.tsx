import { useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { useResource } from '../../lib/connection';
import { useRootNavigation } from '../../navigation/routes';
import { useTabHeader } from '../../navigation/tab-header';
import { StatusGlyph } from '../../ui/glyphs';
import { Button } from '../../ui/button';
import { EmptyState, ListGroup, ListRow, SectionHeader } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Segmented } from '../../ui/segmented';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { TONE_TEXT } from '../Run/run-view';
import {
  flowRunId,
  flowSections,
  flowStatus,
  flowTrailing,
  matchingFlows,
  type FlowSection,
} from './flow-list';

/** Something happening now: the Flow, and its run's state on the right. Opens the run. */
function ActivityRow({ flow }: { flow: MobileFlow }) {
  const navigation = useRootNavigation();
  const status = flowStatus(flow);
  const trailing = flowTrailing(flow);
  const runId = flowRunId(flow)!;
  return (
    <ListRow
      testID={`flow-activity-${flow.id}`}
      accessibilityLabel={`${flow.name}, ${status.word}`}
      title={flow.name}
      subtitle={flowTrailing(flow)?.text === status.word ? flow.description : status.word}
      onPress={() => navigation.navigate('Run', { id: runId })}
      trailing={
        trailing && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <StatusGlyph glyph={status.glyph} tone={status.tone} size={14} />
            <Text variant="secondary" color={TONE_TEXT[trailing.tone]}>
              {trailing.text}
            </Text>
          </View>
        )
      }
    />
  );
}

/** A Flow you can run or look into. Reading a definition never starts work. */
function LibraryRow({ flow }: { flow: MobileFlow }) {
  const navigation = useRootNavigation();
  return (
    <ListRow
      testID={`flow-row-${flow.id}`}
      accessibilityLabel={`${flow.name}, ${flow.enabled ? 'Enabled' : 'Off'}, ${flowStatus(flow).word}`}
      title={flow.name}
      subtitle={[flowStatus(flow).word, flow.description].filter(Boolean).join(' · ')}
      onPress={() => navigation.navigate('Flow', { id: flow.id })}
      trailing={
        <Text variant="secondary" color="muted">
          {flow.enabled ? 'On' : 'Off'}
        </Text>
      }
    />
  );
}

const VIEWS = [
  { id: 'activity', label: 'Activity' },
  { id: 'library', label: 'Library' },
] as const;
type FlowView = (typeof VIEWS)[number]['id'];

function ActivitySection({ section }: { section: FlowSection }) {
  return (
    <View>
      <SectionHeader title={section.title} count={section.flows.length} />
      {section.id === 'results' && (
        <Text
          variant="secondary"
          color="muted"
          style={{ paddingHorizontal: GUTTER, paddingBottom: space.sm }}
        >
          Latest run per flow
        </Text>
      )}
      <ListGroup>
        {section.flows.map((flow) => (
          <ActivityRow key={flow.id} flow={flow} />
        ))}
      </ListGroup>
    </View>
  );
}

function FlowActivity({
  flows,
  query,
  onBrowse,
}: {
  flows: MobileFlow[];
  query: string;
  onBrowse: () => void;
}) {
  const sections = useMemo(() => flowSections(flows), [flows]);
  if (!sections.length)
    return (
      <EmptyState
        title={query ? `No runs match “${query}”` : 'No runs yet'}
        detail="Choose a flow from Library to run it."
        action={
          <Button variant="secondary" onPress={onBrowse}>
            Browse flows
          </Button>
        }
      />
    );
  return sections.map((section) => <ActivitySection key={section.id} section={section} />);
}

function FlowLibrary({ flows }: { flows: MobileFlow[] }) {
  return (
    <>
      <SectionHeader title="Library" count={flows.length} />
      <ListGroup>
        {flows.map((flow) => (
          <LibraryRow key={flow.id} flow={flow} />
        ))}
      </ListGroup>
    </>
  );
}

function FlowContent({
  flows,
  query,
  view,
  onBrowse,
}: {
  flows: MobileFlow[];
  query: string;
  view: FlowView;
  onBrowse: () => void;
}) {
  const matches = useMemo(() => matchingFlows(flows, query), [flows, query]);
  if (!flows.length)
    return <EmptyState title="No Flows yet" detail="Create a flow in Frink on your Mac." />;
  if (!matches.length)
    return (
      <EmptyState title={`No Flows match “${query}”`} detail="Try another name or description." />
    );
  if (view === 'library') return <FlowLibrary flows={matches} />;
  return <FlowActivity flows={matches} query={query} onBrowse={onBrowse} />;
}

/** Supervise current work, or choose a saved Flow to inspect and run. */
export function FlowsScreen() {
  const t = useTheme();
  const resource = useResource({ type: 'flows' }, { interval: 5000 });
  const { data, error, refreshing, pull } = resource;
  const { query, header } = useTabHeader({ title: 'Flows', search: 'Search flows' });
  const [view, setView] = useState<FlowView>('activity');
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
        <View style={{ paddingHorizontal: GUTTER, paddingTop: space.md }}>
          <Segmented items={VIEWS} value={view} onChange={setView} />
        </View>
        <ResourceStatus {...resource} />
        {data ? (
          <FlowContent flows={data} query={query} view={view} onBrowse={() => setView('library')} />
        ) : (
          !error && <ActivityIndicator color={t.muted} style={{ marginTop: 64 }} />
        )}
      </ScrollView>
    </Screen>
  );
}
