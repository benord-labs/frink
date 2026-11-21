import * as Crypto from 'expo-crypto';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Play } from 'lucide-react-native';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { useAction } from '../../../lib/connection';
import { useRootNavigation } from '../../../navigation/routes';
import { StatusGlyph } from '../../../ui/glyphs';
import { ListGroup, ListRow } from '../../../ui/list';
import { Switch } from '../../../ui/switch';
import { Text } from '../../../ui/text';
import { GUTTER, space, useTheme } from '../../../ui/theme';
import { flowStatus } from '../../Flows/flow-list';
import { currentRunId, runNowBlocker, saveEnabled, triggerWords } from '../flow-view';

/** Puts the Flow's on/off switch in the navigation bar; returns its shown position and any error. */
export function useEnabledSwitch(flow: MobileFlow | undefined, onChanged: () => void) {
  const navigation = useRootNavigation();
  const action = useAction();
  // Holds the new position until the computer's next answer confirms it, so the switch never snaps back.
  const [pending, setPending] = useState<boolean | null>(null);
  const saved = flow?.enabled;
  useEffect(() => {
    if (pending === saved) setPending(null);
  }, [pending, saved]);
  const enabled = pending ?? saved;
  const toggle = useRef<(value: boolean) => void>(() => {});
  toggle.current = (value) => {
    if (!flow) return;
    const send = async (enabled: boolean) =>
      !!(await action.run({ type: 'setFlowEnabled', id: flow.id, enabled }));
    void saveEnabled(value, { show: setPending, send, saved: onChanged });
  };
  const busy = action.busy;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight:
        enabled === undefined
          ? undefined
          : () => (
              <Switch
                accessibilityLabel="Enabled"
                value={enabled}
                disabled={busy}
                onValueChange={(value) => toggle.current(value)}
              />
            ),
    });
  }, [navigation, enabled, busy]);
  return { enabled, error: action.error };
}

/** The live run and its state, which opens it; or Run now, with what it waits on. */
export function PrimaryRow({
  flow,
  executionReady,
  switchError,
  onChanged,
}: {
  flow: MobileFlow;
  executionReady?: boolean;
  switchError: string | null;
  onChanged: () => void;
}) {
  const t = useTheme();
  const navigation = useRootNavigation();
  const action = useAction();
  // One id per intended run: a retry after a lost answer can't start a second run.
  const requestId = useRef(Crypto.randomUUID());
  const current = currentRunId(flow);
  const blocker = runNowBlocker(flow, executionReady);
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
  const status = flowStatus(flow);
  const error = action.error ?? switchError;
  return (
    <View style={{ gap: space.sm }}>
      <ListGroup>
        {current ? (
          <ListRow
            testID="flow-current-run"
            accessibilityLabel="View current run"
            leading={<StatusGlyph glyph={status.glyph} tone={status.tone} size={18} />}
            title="View current run"
            onPress={() => navigation.navigate('Run', { id: current })}
          />
        ) : (
          <ListRow
            testID="flow-run-now"
            accessibilityLabel="Run now"
            leading={<Play size={18} color={blocker ? t.muted : t.accent} />}
            title="Run now"
            subtitle={blocker ?? triggerWords(flow.trigger)}
            trailing={action.busy && <ActivityIndicator color={t.muted} />}
            dimmed={!!blocker}
            onPress={blocker ? undefined : () => void start()}
          />
        )}
      </ListGroup>
      {error && (
        <Text variant="secondary" color="danger" style={{ paddingHorizontal: GUTTER }}>
          {error}
        </Text>
      )}
    </View>
  );
}
