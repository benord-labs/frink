import { Fragment } from 'react';
import { Pressable, View } from 'react-native';
import type { MobileFlow, MobileResponses } from '@frink/shared/types/remote/mobile';
import { runStatus } from '../../../lib/status';
import { useRootNavigation } from '../../../navigation/routes';
import { ListRow, RowSeparator } from '../../../ui/list';
import { Text } from '../../../ui/text';
import { GUTTER, space } from '../../../ui/theme';
import { StatusGlyph } from '../../../ui/glyphs';
import { runElapsed, runWhen, TONE_TEXT } from '../../Run/run-view';

type Run = MobileResponses['flow']['runs']['items'][number];

function RunRow({ run, shown }: { run: Run; shown: string }) {
  const navigation = useRootNavigation();
  const status = runStatus(shown);
  const when = runWhen(run.startedAt ?? run.createdAt);
  const took = run.startedAt ? runElapsed(run) : '';
  return (
    <ListRow
      testID={`run-row-${run.id}`}
      accessibilityLabel={`${when}, ${status.word}${took ? `, ${took}` : ''}`}
      leading={<StatusGlyph glyph={status.glyph} tone={status.tone} size={18} />}
      title={when}
      subtitle={
        <Text variant="secondary" color={TONE_TEXT[status.tone]} numberOfLines={1}>
          {status.word}
        </Text>
      }
      trailing={
        took ? (
          <Text variant="secondary" color="muted" style={{ fontVariant: ['tabular-nums'] }}>
            {took}
          </Text>
        ) : undefined
      }
      onPress={() => navigation.navigate('Run', { id: run.id })}
    />
  );
}

/** The live run reads as the Flow does ("Waiting for you", not the engine's "Paused"). */
function liveStatus(flow: MobileFlow, run: Run): string {
  return run.id === flow.latestRunId && flow.status ? flow.status : run.status;
}

/** Newest runs first; "Show more" widens the window the computer sends. */
export function RecentRuns({
  flow,
  runs,
  onMore,
  loadingMore,
}: {
  flow: MobileFlow;
  runs: MobileResponses['flow']['runs'];
  onMore: () => void;
  loadingMore: boolean;
}) {
  if (!runs.items.length)
    return (
      <Text variant="secondary" color="muted" style={{ paddingHorizontal: GUTTER }}>
        No runs yet. Runs appear here as soon as one starts.
      </Text>
    );
  return (
    <View>
      {runs.items.map((run, index) => (
        <Fragment key={run.id}>
          {index > 0 && <RowSeparator />}
          <RunRow run={run} shown={liveStatus(flow, run)} />
        </Fragment>
      ))}
      {runs.hasMore && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: loadingMore }}
          disabled={loadingMore}
          onPress={onMore}
          style={({ pressed }) => ({
            minHeight: 44,
            justifyContent: 'center',
            paddingLeft: GUTTER + 18 + space.md,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text
            variant="secondary"
            color={loadingMore ? 'muted' : 'accent'}
            style={{ fontWeight: '600' }}
          >
            {loadingMore ? 'Loading…' : 'Show more'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
