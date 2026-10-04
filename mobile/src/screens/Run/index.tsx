import { useRoute, type RouteProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import type { MobileRun, MobileRunNode } from '@frink/shared/types/remote/mobile';
import { useAction, useResource } from '../../lib/connection';
import { useLargeTitle } from '../../navigation/large-title';
import type { RootRoutes } from '../../navigation/routes';
import { StatusGlyph } from '../../ui/glyphs';
import { SectionHeader } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { READINESS } from '../Flow/readiness';
import {
  isTerminal,
  needsDecision,
  runElapsed,
  runHeadline,
  runProgress,
  runWhen,
  TONE_TEXT,
} from './run-view';
import { RunTimeline } from './RunTimeline';
import { StopRun } from './StopRun';

/** Where the run stands at a glance: its state, then progress and time on one quiet line. */
function RunSummary({ run }: { run: MobileRun }) {
  const status = runHeadline(run);
  const elapsed = run.startedAt ? runElapsed(run) : '';
  // A finished run is a record, so it says when; a run in progress only needs how long so far.
  const finished = isTerminal(run.status);
  return (
    <View testID="run-summary" style={{ paddingHorizontal: GUTTER, gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <StatusGlyph glyph={status.glyph} tone={status.tone} size={22} />
        <Text
          variant="title"
          color={TONE_TEXT[status.tone] === 'muted' ? 'text' : TONE_TEXT[status.tone]}
        >
          {status.word}
        </Text>
      </View>
      <Text variant="secondary" color="muted">
        {[runProgress(run), elapsed, finished && runWhen(run.startedAt ?? run.createdAt)]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </View>
  );
}

/** One Flow run: its step timeline, the decisions it waits on, and Stop. */
export function RunScreen() {
  const t = useTheme();
  const { params } = useRoute<RouteProp<RootRoutes, 'Run'>>();
  const action = useAction();
  // The step last acted on, so a failed Approve or Skip explains itself beside its buttons.
  const [acted, setActed] = useState<string | null>(null);
  const readiness = useResource(READINESS, { interval: 10000 });
  // Poll quickly while the run can still change; a finished run only needs an occasional check.
  const [finished, setFinished] = useState(false);
  const resource = useResource(
    { type: 'run', id: params.id },
    { interval: finished ? 15000 : 2000 },
  );
  const { data: run, error, refreshing, pull, refresh } = resource;
  const terminal = !!run && isTerminal(run.status);
  useEffect(() => setFinished(terminal), [terminal]);
  const title = run?.flowName;
  const heading = useLargeTitle(title);
  const waiting = run && !terminal ? run.nodes.filter(needsDecision) : [];
  const timeline = run?.nodes.filter((node) => !waiting.includes(node)) ?? [];
  const decisionState = {
    busy: action.busy,
    ready: readiness.data?.executionReady !== false,
    error: acted ? { nodeId: acted, text: action.error } : null,
    resume: (node: MobileRunNode, operation: 'approve' | 'skip') => void resume(node, operation),
  };
  async function resume(node: MobileRunNode, operation: 'approve' | 'skip') {
    setActed(node.id);
    const done = await action.run({
      type: 'resumeNode',
      runId: params.id,
      nodeRunId: node.id,
      actionToken: node.actionToken,
      action: operation,
    });
    if (done) refresh();
  }
  async function stop() {
    setActed(null);
    const done = await action.run({ type: 'cancelRun', id: params.id });
    if (done) refresh();
    return !!done;
  }
  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 64 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} />}
      >
        {heading}
        <ResourceStatus {...resource} />
        {!run ? (
          !error && <ActivityIndicator color={t.muted} style={{ marginTop: 64 }} />
        ) : (
          <View style={{ paddingTop: space.lg }}>
            <RunSummary run={run} />
            {waiting.length > 0 && (
              <>
                <SectionHeader title="Needs you" count={waiting.length} />
                <RunTimeline nodes={waiting} {...decisionState} />
              </>
            )}
            {(timeline.length > 0 || waiting.length === 0) && (
              <>
                <SectionHeader title="Timeline" count={timeline.length || undefined} />
                <RunTimeline nodes={timeline} {...decisionState} />
              </>
            )}
            {!isTerminal(run.status) && (
              <View style={{ paddingTop: space.xxl }}>
                <StopRun busy={action.busy} error={acted ? null : action.error} onStop={stop} />
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
