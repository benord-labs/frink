import * as Crypto from 'expo-crypto';
import { useRef, useState, type ComponentProps } from 'react';
import { Switch, View } from 'react-native';
import type { MobileRunNode } from '../../../../src/shared/types/remote/mobile';
import { useAction, useResource } from '../../lib/connection';
import {
  Button,
  Icon,
  Label,
  Loading,
  Notice,
  Page,
  Row,
  Section,
  Status,
} from '../../ui/primitives';
import { useTheme } from '../../ui/theme';
import { glassStyle } from '../../ui/material';

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
  const { data, error, refresh } = useResource({ type: 'flows' });
  return (
    <Page title="Flows">
      {error && (
        <View style={{ gap: 12 }}>
          <Notice error>{error}</Notice>
          <Button compact secondary icon="refresh-outline" onPress={refresh}>
            Refresh Flows
          </Button>
        </View>
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
                <View>
                  {flows.map((flow) => (
                    <Row
                      key={flow.id}
                      title={flow.name}
                      subtitle={triggerInfo(flow.trigger).label}
                      status={flow.status}
                      onPress={() => openFlow(flow.id)}
                      icon={triggerInfo(flow.trigger).icon}
                    />
                  ))}
                </View>
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
  const { data, error, refresh } = useResource({ type: 'flow', id });
  const action = useAction();
  const requestId = useRef(Crypto.randomUUID());
  const t = useTheme();
  async function start() {
    const result = await action.run({ type: 'startFlow', id, requestId: requestId.current });
    if (result) {
      requestId.current = Crypto.randomUUID();
      openRun(result.id);
    }
  }
  return (
    <Page compact title={data?.flow.name ?? 'Flow'} onBack={onBack}>
      {(error || action.error) && <Notice error>{error || action.error}</Notice>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {!!data.flow.description && (
            <Label muted size={14}>
              {data.flow.description}
            </Label>
          )}
          <View style={{ gap: 16 }}>
            <View
              style={{
                ...glassStyle(t),
                borderRadius: 10,
                padding: 16,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 13,
              }}
            >
              <Icon name={triggerInfo(data.flow.trigger).icon} size={21} color={t.secondary} />
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <Label bold size={15}>
                  Automation enabled
                </Label>
                <Label muted size={13}>
                  {triggerInfo(data.flow.trigger).label}
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
            <Button
              compact
              icon="play"
              disabled={action.busy || !data.flow.enabled}
              onPress={() => void start()}
            >
              {action.busy ? 'Starting…' : 'Run Flow'}
            </Button>
          </View>
          <Section title="Recent runs">
            {data.runs.length ? (
              <View>
                {data.runs.map((run) => (
                  <Row
                    key={run.id}
                    title={
                      run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Waiting to start'
                    }
                    status={run.status}
                    icon="git-commit-outline"
                    onPress={() => openRun(run.id)}
                  />
                ))}
              </View>
            ) : (
              <Label muted size={14}>
                No runs yet.
              </Label>
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
  const completed = node.status === 'completed';
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View style={{ width: 26, alignItems: 'center' }}>
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.field,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {completed ? (
            <Icon name="checkmark" size={15} color={t.success} />
          ) : (
            <Label muted size={12} bold>
              {index + 1}
            </Label>
          )}
        </View>
        {!last && (
          <View
            style={{ flex: 1, width: 1, backgroundColor: t.border, marginTop: 7, marginBottom: 7 }}
          />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 24, gap: 12 }}>
        <View style={{ gap: 5, paddingTop: 1 }}>
          <Label bold size={16}>
            {node.label}
          </Label>
          <Status value={node.status} />
        </View>
        {!!node.detail && (
          <View style={{ borderRadius: 9, ...glassStyle(t), overflow: 'hidden' }}>
            <View
              style={{
                paddingHorizontal: 14,
                paddingVertical: 11,
                flexDirection: 'row',
                gap: 7,
                alignItems: 'center',
                borderBottomWidth: 1,
                borderColor: t.border,
              }}
            >
              <Icon name="document-text-outline" size={16} color={t.muted} />
              <Label muted size={12}>
                {node.actions.includes('approve') ? 'Review this step' : 'Step details'}
              </Label>
            </View>
            <View style={{ padding: 14 }}>
              <Label size={14} style={{ color: t.secondary, lineHeight: 23 }}>
                {node.detail}
              </Label>
            </View>
          </View>
        )}
        {!!(node.actions.length || node.chatId) && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
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
  const { data, error, refresh } = useResource({ type: 'run', id });
  const action = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const t = useTheme();
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
    <Page compact title={data?.flowName ?? 'Flow run'} onBack={onBack}>
      {(error || action.error) && <Notice error>{error || action.error}</Notice>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <Label muted size={14}>
              Run progress
            </Label>
            <Status value={data.status} />
          </View>
          <View>
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
            {!data.nodes.length && (
              <Label muted size={14}>
                Waiting for steps.
              </Label>
            )}
          </View>
          {!['completed', 'failed', 'cancelled'].includes(data.status) && (
            <View style={{ borderTopWidth: 1, borderColor: t.border, paddingTop: 18 }}>
              {confirmCancel ? (
                <View style={{ gap: 12 }}>
                  <Notice>Stop this Flow and its remaining steps?</Notice>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    <Button
                      compact
                      secondary
                      destructive
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
                    <Button compact secondary onPress={() => setConfirmCancel(false)}>
                      Keep running
                    </Button>
                  </View>
                </View>
              ) : (
                <Button
                  compact
                  secondary
                  icon="stop-outline"
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
