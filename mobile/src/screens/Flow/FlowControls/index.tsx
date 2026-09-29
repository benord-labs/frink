import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { Platform, Switch, View } from 'react-native';
import {
  Activity,
  CalendarClock,
  CircleCheckBig,
  Play,
  Power,
  Webhook,
  type LucideIcon,
} from 'lucide-react-native';
import type { MobileFlow } from '../../../../../src/shared/types/remote/mobile';
import { useAction } from '../../../lib/connection';
import { useRootNavigation } from '../../../navigation/routes';
import { Button } from '../../../ui/button';
import { ListRow } from '../../../ui/list';
import { Text } from '../../../ui/text';
import { GUTTER, space, useTheme } from '../../../ui/theme';
import { IconTile } from '../../Flows/Tile';
import { isLive } from '../../Run/run-view';
import { enabledHint, runNowBlocker } from '../flow-view';

const TRIGGER_ICONS: Record<string, LucideIcon> = {
  schedule_trigger: CalendarClock,
  webhook_trigger: Webhook,
  post_task_trigger: CircleCheckBig,
};

function EnabledRow({ flow, onChanged }: { flow: MobileFlow; onChanged: () => void }) {
  const t = useTheme();
  const action = useAction();
  // Holds the new position until the computer's next answer confirms it, so the switch never snaps back.
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => {
    if (pending === flow.enabled) setPending(null);
  }, [pending, flow.enabled]);
  const enabled = pending ?? flow.enabled;
  async function toggle(value: boolean) {
    setPending(value);
    if (await action.run({ type: 'setFlowEnabled', id: flow.id, enabled: value })) onChanged();
    else setPending(null);
  }
  return (
    <View>
      <ListRow
        leading={<IconTile icon={TRIGGER_ICONS[flow.trigger] ?? Power} />}
        title="Enabled"
        subtitle={enabledHint({ enabled, trigger: flow.trigger })}
        trailing={
          <Switch
            accessibilityLabel="Enabled"
            value={enabled}
            disabled={action.busy}
            onValueChange={(value) => void toggle(value)}
            trackColor={{ true: t.accent, false: t.field }}
            thumbColor="#FFFFFF"
            {...(Platform.OS === 'web' ? { activeThumbColor: '#FFFFFF' } : {})}
          />
        }
      />
      {action.error && (
        <Text variant="secondary" color="danger" style={{ paddingHorizontal: GUTTER }}>
          {action.error}
        </Text>
      )}
    </View>
  );
}

function RunNow({
  flow,
  executionReady,
  onChanged,
}: {
  flow: MobileFlow;
  executionReady?: boolean;
  onChanged: () => void;
}) {
  const navigation = useRootNavigation();
  const action = useAction();
  // One id per intended run: a retry after a lost answer can't start a second run.
  const requestId = useRef(Crypto.randomUUID());
  const blocker = runNowBlocker(flow, executionReady);
  const current = isLive(flow.status) ? flow.latestRunId : null;
  async function start() {
    const result = await action.run({
      type: 'startFlow',
      id: flow.id,
      requestId: requestId.current,
    });
    if (!result) return;
    requestId.current = Crypto.randomUUID();
    // Refresh now so coming back shows the live run, not a Run now that would start another.
    onChanged();
    navigation.navigate('Run', { id: result.id });
  }
  if (current)
    return (
      <View style={{ paddingHorizontal: GUTTER }}>
        <Button
          variant="secondary"
          icon={Activity}
          onPress={() => navigation.navigate('Run', { id: current })}
        >
          View current run
        </Button>
      </View>
    );
  return (
    <View style={{ paddingHorizontal: GUTTER, gap: space.sm }}>
      <Button icon={Play} disabled={!!blocker} busy={action.busy} onPress={() => void start()}>
        Run now
      </Button>
      {(action.error ?? blocker) && (
        <Text
          variant="secondary"
          color={action.error ? 'danger' : 'muted'}
          style={{ textAlign: 'center' }}
        >
          {action.error ?? blocker}
        </Text>
      )}
    </View>
  );
}

/** Run now, then the switch that turns the Flow on or off. */
export function FlowControls({
  flow,
  executionReady,
  onChanged,
}: {
  flow: MobileFlow;
  executionReady?: boolean;
  onChanged: () => void;
}) {
  return (
    <View style={{ gap: space.lg }}>
      <RunNow flow={flow} executionReady={executionReady} onChanged={onChanged} />
      <EnabledRow flow={flow} onChanged={onChanged} />
    </View>
  );
}
