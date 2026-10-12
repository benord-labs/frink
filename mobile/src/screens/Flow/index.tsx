import { useRoute, type RouteProp } from '@react-navigation/native';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { useResource } from '../../lib/connection';
import { useWindow } from '../../lib/use-window';
import { usePageTitle } from '../../navigation/page-title';
import { useRootNavigation, type RootRoutes } from '../../navigation/routes';
import { ListRow, SectionHeader } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { FlowControls } from './FlowControls';
import { FlowOutline } from './FlowOutline';
import { currentRunId, flowAttention } from './flow-view';
import { READINESS } from './readiness';
import { RecentRuns } from './RecentRuns';

/** One row above the controls that says what a Flow in "Needs you" is waiting on. */
function Attention({ flow }: { flow: MobileFlow }) {
  const navigation = useRootNavigation();
  const attention = flowAttention(flow);
  if (!attention || currentRunId(flow)) return null;
  return (
    <View style={{ paddingBottom: space.lg }}>
      <ListRow
        testID="flow-attention"
        accessibilityLabel={`${attention.title}, ${attention.subtitle}`}
        title={attention.title}
        subtitle={attention.subtitle}
        onPress={() => navigation.navigate('Run', { id: attention.runId })}
      />
    </View>
  );
}

/** One Flow: run it, turn it on or off, see its recent runs and how it is built. */
export function FlowScreen() {
  const t = useTheme();
  const [stepsOpen, setStepsOpen] = useState(false);
  const { params } = useRoute<RouteProp<RootRoutes, 'Flow'>>();
  const runs = useWindow(5, 10, 100);
  const resource = useResource(
    { type: 'flow', id: params.id, runLimit: runs.limit },
    { keep: true },
  );
  const readiness = useResource(READINESS, { interval: 10000 });
  const { data, error, stale, refreshing, pull, refresh } = resource;
  const name = data?.flow.name;
  const heading = usePageTitle(name);
  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 64 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} />}
      >
        {heading}
        <ResourceStatus {...resource} />
        {!data ? (
          !error && <ActivityIndicator color={t.muted} style={{ marginTop: 64 }} />
        ) : (
          <View style={{ paddingTop: space.lg }}>
            {!!data.flow.description && (
              <Text
                color="secondary"
                style={{ paddingHorizontal: GUTTER, paddingBottom: space.xl }}
              >
                {data.flow.description}
              </Text>
            )}
            <Attention flow={data.flow} />
            <FlowControls
              flow={data.flow}
              executionReady={readiness.data?.executionReady}
              onChanged={refresh}
            />
            <SectionHeader title="Recent runs" />
            <RecentRuns flow={data.flow} runs={data.runs} onMore={runs.more} loadingMore={stale} />
            <SectionHeader
              title="Steps"
              count={data.definition?.nodes.length}
              action={stepsOpen ? 'Hide steps' : 'Show steps'}
              onAction={() => setStepsOpen((shown) => !shown)}
            />
            {stepsOpen && <FlowOutline definition={data.definition} />}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
