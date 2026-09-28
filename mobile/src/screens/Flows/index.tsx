import * as Crypto from 'expo-crypto';
import { useRef, useState, type ComponentProps } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';
import type { MobileRunNode } from '../../../../src/shared/types/remote/mobile';
import { useAction, useResource } from '../../lib/connection';
import { Button, Card, CardNote, IconTile, Icon, Label, Loading, Notice, Row, Section, Status, statusTone, toneColors } from '../../ui/primitives';
import { Page } from '../../ui/page';
import { useTheme } from '../../ui/theme';
import { ResourceStatus } from '../../ui/resource-status';
import { SearchField } from '../../ui/search-field';
import { Markdown } from '../../ui/Markdown';
import { FlowOutline } from './FlowOutline';

const triggers: Record<string, { label: string; icon: ComponentProps<typeof Icon>['name'] }> = {
  manual_trigger: { label: 'Run manually', icon: 'play-outline' },
  schedule_trigger: { label: 'Runs on a schedule', icon: 'calendar-outline' },
  webhook_trigger: { label: 'Triggered by a webhook', icon: 'link-outline' },
  post_task_trigger: { label: 'Runs after a task', icon: 'checkmark-done-outline' },
};

function triggerInfo(trigger: string) {
  return (
    triggers[trigger] ?? {
      label: trigger.replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase()),
      icon: 'git-network-outline' as const,
    }
  );
}

// Reason: The Flow list keeps loading, failure, empty and enabled groups together.
// fallow-ignore-next-line complexity
export function Flows({ openFlow }: { openFlow: (id: string) => void }) {
  const resource = useResource({ type: 'flows' });
  const { data, error, refresh, pull, refreshing } = resource;
  const [query, setQuery] = useState('');
  const filtered = data?.filter((flow) =>
    `${flow.name} ${flow.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Page root title="Flows" refreshing={refreshing} onRefresh={pull}>
      <ResourceStatus {...resource} />
      {!!data?.length && (
        <SearchField value={query} onChangeText={setQuery} placeholder="Search Flows" />
      )}
      {!data ? (
        !error && <Loading />
      ) : !data.length ? (
        <Card>
          <CardNote>
            Create your first Flow on your computer. You can run it and follow its progress here.
          </CardNote>
        </Card>
      ) : !filtered?.length ? (
        <Card>
          <CardNote>No Flows match “{query.trim()}”. Try another name or description.</CardNote>
        </Card>
      ) : (
        <>
          {([true, false] as const).map((enabled) => {
            const flows = filtered.filter((flow) => flow.enabled === enabled);
            return flows.length ? (
              <Section key={String(enabled)} title={enabled ? 'Enabled' : 'Paused automations'}>
                {flows.map((flow, index) => (
                  <Row
                    key={flow.id}
                    separator={index < flows.length - 1}
                    title={flow.name}
                    subtitle={flow.description || triggerInfo(flow.trigger).label}
                    status={enabled ? flow.status : undefined}
                    dimmed={!enabled}
                    onPress={() => openFlow(flow.id)}
                    icon={triggerInfo(flow.trigger).icon}
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

// Reason: The Flow view keeps loading, toggle, launch and recent-run feedback together.
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
  const resource = useResource({ type: 'flow', id });
  const { data, error, refresh, pull, refreshing } = resource;
  const action = useAction();
  const [starting, setStarting] = useState(false);
  const requestId = useRef(Crypto.randomUUID());
  const t = useTheme();
  async function start() {
    setStarting(true);
    const result = await action.run({ type: 'startFlow', id, requestId: requestId.current });
    setStarting(false);
    if (result) {
      requestId.current = Crypto.randomUUID();
      openRun(result.id);
    }
  }
  return (
    <Page
      title={data?.flow.name ?? 'Flow'}
      onBack={onBack}
      refreshing={refreshing}
      onRefresh={pull}
    >
      <ResourceStatus {...resource} />
      {action.error && <Notice error>{action.error}</Notice>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {!!data.flow.description && (
            <Label muted size={15} style={{ paddingHorizontal: 4 }}>
              {data.flow.description}
            </Label>
          )}
          <View style={{ gap: 12 }}>
            <Card>
              <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
              >
                <IconTile name={triggerInfo(data.flow.trigger).icon} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Label size={16} style={{ fontWeight: '500' }}>
                    Automation enabled
                  </Label>
                  <Label muted size={14}>
                    {triggerInfo(data.flow.trigger).label}
                  </Label>
                </View>
                <Switch
                  accessibilityLabel="Automation enabled"
                  value={data.flow.enabled}
                  disabled={action.busy}
                  trackColor={{ true: t.accent, false: t.raised }}
                  thumbColor="#FFFFFF"
                  {...(Platform.OS === 'web' ? { activeThumbColor: '#FFFFFF' } : {})}
                  onValueChange={async (enabled) => {
                    if (await action.run({ type: 'setFlowEnabled', id, enabled })) refresh();
                  }}
                />
              </View>
            </Card>
            <Button
              icon="play"
              disabled={action.busy || !data.flow.enabled}
              onPress={() => void start()}
            >
              {starting ? 'Starting…' : 'Run Flow'}
            </Button>
          </View>
          <FlowOutline definition={data.definition} />
          <Section title="Recent runs">
            {data.runs.length ? (
              data.runs.map((run, index) => (
                <Row
                  key={run.id}
                  separator={index < data.runs.length - 1}
                  title={
                    run.startedAt
                      ? new Date(run.startedAt).toLocaleString([], {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })
                      : 'Waiting to start'
                  }
                  status={run.status}
                  icon="time-outline"
                  onPress={() => openRun(run.id)}
                />
              ))
            ) : (
              <CardNote>No runs yet.</CardNote>
            )}
          </Section>
        </>
      )}
    </Page>
  );
}

// Reason: A run step presents its real status, detail and permitted actions in one row.
// fallow-ignore-next-line complexity
function RunStep({
  node,
  index,
  last,
  busy,
  resume,
  openChat,
}: {
  node: MobileRunNode;
  index: number;
  last: boolean;
  busy: boolean;
  resume: (node: MobileRunNode, operation: 'approve' | 'skip') => void;
  openChat: (id: string, subChatId?: string) => void;
}) {
  const t = useTheme();
  const { fg, bg } = toneColors(t, statusTone(node.status));
  return (
    <View
      style={{
        gap: 12,
        padding: 14,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderColor: t.border,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {node.status === 'completed' ? (
            <Icon name="checkmark" size={16} color={fg} />
          ) : (
            <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '700', color: fg }}>
              {index + 1}
            </Text>
          )}
        </View>
        <Label bold size={16} style={{ flex: 1 }}>
          {node.label}
        </Label>
        <Status value={node.status} />
      </View>
      {!!node.detail && (
        <View style={{ paddingLeft: 42 }}>
          <Markdown content={node.detail} />
        </View>
      )}
      {!!(node.actions.length || node.chatId) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 42 }}>
          {node.actions.map((operation) => (
            <Button
              key={operation}
              compact
              icon={operation === 'approve' ? 'checkmark' : 'play-skip-forward-outline'}
              secondary={operation !== 'approve'}
              disabled={busy}
              onPress={() => resume(node, operation)}
            >
              {operation === 'approve' ? 'Approve this step' : 'Skip step'}
            </Button>
          ))}
          {node.chatId && (
            <Button
              compact
              secondary
              icon="chatbubble-outline"
              onPress={() => openChat(node.chatId!, node.subChatId ?? undefined)}
            >
              Open chat
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

// Reason: Run review keeps loading, approval and confirmed cancellation states together.
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
  const resource = useResource({ type: 'run', id });
  const { data, error, refresh, pull, refreshing } = resource;
  const action = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  async function resume(node: MobileRunNode, operation: 'approve' | 'skip') {
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
  }
  return (
    <Page
      title={data?.flowName ?? 'Flow run'}
      onBack={onBack}
      refreshing={refreshing}
      onRefresh={pull}
    >
      <ResourceStatus {...resource} />
      {action.error && <Notice error>{action.error}</Notice>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
              <IconTile name="git-network-outline" tone={statusTone(data.status)} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Label size={16} style={{ fontWeight: '500' }}>
                  Run progress
                </Label>
                <Label muted size={14}>
                  {data.startedAt
                    ? `Started ${new Date(data.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
                    : 'Waiting to start'}
                </Label>
              </View>
              <Status value={data.status} />
            </View>
          </Card>
          <Section title="Steps" count={data.nodes.length || undefined}>
            {data.nodes.map((node, index) => (
              <RunStep
                key={node.id}
                node={node}
                index={index}
                last={index === data.nodes.length - 1}
                busy={action.busy}
                resume={(step, operation) => void resume(step, operation)}
                openChat={openChat}
              />
            ))}
            {!data.nodes.length && <CardNote>Waiting for steps.</CardNote>}
          </Section>
          {!['completed', 'failed', 'cancelled'].includes(data.status) && (
            <View>
              {confirmCancel ? (
                <View style={{ gap: 12 }}>
                  <Notice>Stop this Flow and its remaining steps?</Notice>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button
                      secondary
                      style={{ flex: 1 }}
                      onPress={() => setConfirmCancel(false)}
                    >
                      Keep running
                    </Button>
                    <Button
                      secondary
                      destructive
                      style={{ flex: 1 }}
                      icon="stop-outline"
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
                  </View>
                </View>
              ) : (
                <Button
                  secondary
                  destructive
                  icon="stop-circle-outline"
                  onPress={() => setConfirmCancel(true)}
                >
                  Stop Flow…
                </Button>
              )}
            </View>
          )}
        </>
      )}
    </Page>
  );
}
