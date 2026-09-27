import * as Crypto from 'expo-crypto';
import { useRef, useState } from 'react';
import { Switch, View } from 'react-native';
import { useAction, useResource } from '../../lib/connection';
import { Button, Label, Loading, Notice, Page, Row, Section, Status } from '../../ui/primitives';
import { useTheme } from '../../ui/theme';

// Reason: The MVP Flow list keeps enabled, empty, and loading states together.
// fallow-ignore-next-line complexity
export function Flows({ openFlow }: { openFlow: (id: string) => void }) {
  const { data, error, refresh } = useResource({ type: 'flows' });
  return (
    <Page title="Flows" subtitle="Your automations, still at work.">
      {error && (
        <>
          <Notice error>{error}</Notice>
          <Button secondary onPress={refresh}>
            Refresh Flows
          </Button>
        </>
      )}
      {!data ? (
        !error && <Loading />
      ) : !data.length ? (
        <Notice>
          Create your first Flow on your computer. You can run it and follow its progress here.
        </Notice>
      ) : (
        <>
          {([true, false] as const).map((enabled) => {
            const flows = data.filter((flow) => flow.enabled === enabled);
            return flows.length ? (
              <Section key={String(enabled)} title={enabled ? 'Enabled' : 'Paused automations'}>
                {flows.map((flow) => (
                  <Row
                    key={flow.id}
                    title={flow.name}
                    subtitle={flow.trigger.replaceAll('_', ' ')}
                    status={flow.status}
                    onPress={() => openFlow(flow.id)}
                    icon="git-network-outline"
                  />
                ))}
              </Section>
            ) : null;
          })}
        </>
      )}
    </Page>
  );
}
// Reason: Run controls and recent history form one bounded MVP Flow screen.
// fallow-ignore-next-line complexity
export function FlowDetail({
  id,
  onBack,
  openRun,
}: {
  id: string;
  onBack: () => void;
  openRun: (id: string) => void;
}) {
  const { data, error, refresh } = useResource({ type: 'flow', id });
  const action = useAction();
  const requestId = useRef(Crypto.randomUUID());
  const t = useTheme();
  async function start() {
    const result = await action.run({
      type: 'startFlow',
      id,
      requestId: requestId.current,
    });
    if (result) {
      requestId.current = Crypto.randomUUID();
      openRun(result.id);
    }
  }
  return (
    <Page title={data?.flow.name ?? 'Flow'} onBack={onBack}>
      {(error || action.error) && <Notice error>{error || action.error}</Notice>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {!!data.flow.description && <Label>{data.flow.description}</Label>}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Label bold>Automation enabled</Label>
              <Label muted size={13}>
                {data.flow.trigger.replaceAll('_', ' ')}
              </Label>
            </View>
            <Switch
              accessibilityLabel="Automation enabled"
              value={data.flow.enabled}
              disabled={action.busy}
              trackColor={{ true: t.accent, false: t.border }}
              onValueChange={async (enabled) => {
                if (await action.run({ type: 'setFlowEnabled', id, enabled })) refresh();
              }}
            />
          </View>
          <Button disabled={action.busy || !data.flow.enabled} onPress={() => void start()}>
            {action.busy ? 'Starting…' : 'Run Flow'}
          </Button>
          <Section title="Recent runs">
            {data.runs.length ? (
              data.runs.map((run) => (
                <Row
                  key={run.id}
                  title={
                    run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Waiting to start'
                  }
                  status={run.status}
                  onPress={() => openRun(run.id)}
                />
              ))
            ) : (
              <Label muted>No runs yet.</Label>
            )}
          </Section>
        </>
      )}
    </Page>
  );
}
// Reason: Step review and cancellation states remain together for the MVP.
// fallow-ignore-next-line complexity
export function RunDetail({
  id,
  onBack,
  openChat,
}: {
  id: string;
  onBack: () => void;
  openChat: (id: string, subChatId?: string) => void;
}) {
  const { data, error, refresh } = useResource({ type: 'run', id });
  const action = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const t = useTheme();
  return (
    <Page title={data?.flowName ?? 'Flow run'} subtitle="Run progress" onBack={onBack}>
      {(error || action.error) && <Notice error>{error || action.error}</Notice>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <Status value={data.status} />
          <Section title="Steps">
            {data.nodes.map((node, index) => (
              <View
                key={node.id}
                style={{
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderColor: t.border,
                  gap: 12,
                }}
              >
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <Label muted size={14}>
                    {index + 1}
                  </Label>
                  <View style={{ flex: 1 }}>
                    <Label bold>{node.label}</Label>
                    <Status value={node.status} />
                  </View>
                </View>
                {!!node.detail && <Label size={14}>{node.detail}</Label>}
                {node.actions.map((operation) => (
                  <Button
                    key={operation}
                    secondary={operation !== 'approve'}
                    disabled={action.busy}
                    onPress={async () => {
                      if (
                        await action.run({
                          type: 'resumeNode',
                          runId: id,
                          nodeRunId: node.id,
                          actionToken: node.actionToken,
                          action: operation,
                        })
                      )
                        refresh();
                    }}
                  >
                    {operation === 'approve' ? 'Approve this step' : 'Skip step'}
                  </Button>
                ))}
                {node.chatId && (
                  <Button
                    secondary
                    onPress={() => openChat(node.chatId!, node.subChatId ?? undefined)}
                  >
                    Open chat
                  </Button>
                )}
              </View>
            ))}
          </Section>
          {!['completed', 'failed', 'cancelled'].includes(data.status) &&
            (confirmCancel ? (
              <View style={{ gap: 12 }}>
                <Notice>Stop this Flow and its remaining steps?</Notice>
                <Button
                  secondary
                  destructive
                  disabled={action.busy}
                  onPress={async () => {
                    if (await action.run({ type: 'cancelRun', id })) {
                      setConfirmCancel(false);
                      refresh();
                    }
                  }}
                >
                  Stop Flow
                </Button>
                <Button secondary onPress={() => setConfirmCancel(false)}>
                  Keep running
                </Button>
              </View>
            ) : (
              <Button secondary onPress={() => setConfirmCancel(true)}>
                Stop Flow…
              </Button>
            ))}
        </>
      )}
    </Page>
  );
}
