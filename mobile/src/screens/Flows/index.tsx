import * as Crypto from 'expo-crypto';
import { useMemo } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { useConnection, useResource } from '../../lib/connection';
import { useOverview } from '../../lib/overview';
import { shortAge } from '../../lib/status';
import { useRootNavigation } from '../../navigation/routes';
import { useScreenHeader } from '../../navigation/screen-header';
import { StatusGlyph } from '../../ui/glyphs';
import { EmptyState, ListGroup, ListRow, SectionHeader } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { space, useTheme } from '../../ui/theme';
import { needsYouCount } from '../Queue/queue-view';
import { TONE_TEXT } from '../Run/run-view';
import { createFlowActions, flowSheet, type RetryPrompt } from './flow-actions';
import { flowStatus, flowSubtitle, groupFlows, matchingFlows, needsYouLabel } from './flow-list';

type OpenMenu = ((flow: MobileFlow) => void) | undefined;

const retryAlert: RetryPrompt = (title, message, retry) =>
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Try again', onPress: retry },
  ]);

/** A run under way or paused, in its state's words. Opens the run. */
function NowRow({ flow, runId }: { flow: MobileFlow; runId: string }) {
  const navigation = useRootNavigation();
  const status = flowStatus(flow);
  return (
    <ListRow
      testID={`flow-now-${flow.id}`}
      accessibilityLabel={`${flow.name}, ${status.word}`}
      leading={<StatusGlyph glyph={status.glyph} tone={status.tone} size={18} />}
      title={flow.name}
      subtitle={
        <Text variant="secondary" color={TONE_TEXT[status.tone]} numberOfLines={1}>
          {status.word}
        </Text>
      }
      trailing={
        <Text variant="secondary" color="muted">
          {shortAge(flow.lastRun?.at)}
        </Text>
      }
      onPress={() => navigation.navigate('Run', { id: runId })}
    />
  );
}

/** The Queue owns what needs you; the Flows list only links to it. */
function NeedsYouRow({ label }: { label: string }) {
  const navigation = useRootNavigation();
  return (
    <ListRow
      testID="flows-needs-you"
      leading={<StatusGlyph glyph="awaiting" tone="attention" size={18} />}
      title={label}
      subtitle="Open the Queue"
      onPress={() => navigation.navigate('QueueTab', { screen: 'Queue', pop: true })}
    />
  );
}

/** Every Flow: its last run's state, what it does, and when it last ran. Off Flows are dimmed. */
function FlowRow({ flow, onMenu }: { flow: MobileFlow; onMenu: OpenMenu }) {
  const navigation = useRootNavigation();
  const status = flowStatus(flow);
  return (
    <ListRow
      testID={`flow-row-${flow.id}`}
      accessibilityLabel={[flow.name, status.word, !flow.enabled && 'Off']
        .filter(Boolean)
        .join(', ')}
      leading={<StatusGlyph glyph={status.glyph} tone={status.tone} size={18} />}
      title={flow.name}
      subtitle={flowSubtitle(flow)}
      trailing={
        <Text variant="secondary" color="muted">
          {shortAge(flow.lastRun?.at)}
        </Text>
      }
      dimmed={!flow.enabled}
      onPress={() => navigation.navigate('Flow', { id: flow.id })}
      onLongPress={onMenu && (() => onMenu(flow))}
    />
  );
}

/** Long-press opens the system action sheet on iOS; elsewhere the Flow page has the same actions. */
function useFlowMenu(refresh: () => void): OpenMenu {
  const navigation = useRootNavigation();
  const { request, connection } = useConnection();
  // Pinned to the computer on screen, so Try again asks the computer that refused.
  const actions = useMemo(
    () =>
      createFlowActions(
        {
          start: (id, requestId) =>
            request({ type: 'startFlow', id, requestId }, undefined, connection),
          setEnabled: (id, enabled) =>
            request({ type: 'setFlowEnabled', id, enabled }, undefined, connection),
        },
        retryAlert,
        Crypto.randomUUID,
      ),
    [request, connection],
  );
  if (Platform.OS !== 'ios') return undefined;
  const openRun = (id: string) => navigation.navigate('Run', { id });
  return (flow) => {
    const { options, cancelButtonIndex, pick } = flowSheet(flow, actions, { openRun, refresh });
    ActionSheetIOS.showActionSheetWithOptions(
      { title: flow.name, options, cancelButtonIndex },
      pick,
    );
  };
}

function FlowContent({
  flows,
  query,
  needsYou,
  onMenu,
}: {
  flows: MobileFlow[];
  query: string;
  needsYou: number;
  onMenu: OpenMenu;
}) {
  const groups = useMemo(() => groupFlows(matchingFlows(flows, query)), [flows, query]);
  const label = needsYouLabel(needsYou);
  return (
    <>
      {(label || groups.now.length > 0) && (
        <>
          <SectionHeader title="Now" />
          <ListGroup>
            {label && <NeedsYouRow label={label} />}
            {groups.now.map(({ flow, runId }) => (
              <NowRow key={runId} flow={flow} runId={runId} />
            ))}
          </ListGroup>
        </>
      )}
      {!flows.length ? (
        <EmptyState title="No Flows yet" detail="Create a flow in Frink on your computer." />
      ) : !groups.all.length ? (
        <EmptyState title={`No Flows match “${query}”`} detail="Try another name or description." />
      ) : (
        <>
          <SectionHeader title="All Flows" count={groups.all.length} />
          <ListGroup>
            {groups.all.map((flow) => (
              <FlowRow key={flow.id} flow={flow} onMenu={onMenu} />
            ))}
          </ListGroup>
        </>
      )}
    </>
  );
}

/** What is running now, then every Flow to open, run, or turn on and off. */
export function FlowsScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const resource = useResource({ type: 'flows' }, { interval: 5000 });
  const { data, error, refreshing, pull, refresh } = resource;
  const needsYou = needsYouCount(useOverview().data);
  const { query, header } = useScreenHeader({ title: 'Flows', search: 'Search flows' });
  const openMenu = useFlowMenu(refresh);
  return (
    <Screen>
      <ScrollView
        testID="flows-screen"
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} />}
      >
        {header}
        <ResourceStatus {...resource} />
        {data ? (
          <FlowContent flows={data} query={query} needsYou={needsYou} onMenu={openMenu} />
        ) : (
          !error && <ActivityIndicator color={t.muted} style={{ marginTop: 64 }} />
        )}
      </ScrollView>
    </Screen>
  );
}
