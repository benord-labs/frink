import { useState } from 'react';
import { View } from 'react-native';
import type { MobileQueueItem } from '../../../../src/shared/types/remote/mobile';
import type { useResource } from '../../lib/connection';
import {
  Card,
  CardNote,
  Loading,
  Notice,
  Row,
  Section,
  type IconName,
  type Tone,
} from '../../ui/primitives';
import { Page } from '../../ui/page';
import { Segmented } from '../../ui/segmented';
import { SearchField } from '../../ui/search-field';
import { ResourceStatus } from '../../ui/resource-status';
import { queueView, type Decision, type QueueFilter } from './queue-view';

type Props = {
  openChat: (
    id: string,
    subChatId?: string,
    target?: { type: 'question' | 'permission'; id: string },
  ) => void;
  openRun: (id: string) => void;
};
// Reason: Decision, Flow run and chat destinations resolve in one place.
// fallow-ignore-next-line complexity
function openItem(
  item: Pick<Decision, 'chatId' | 'subChatId' | 'flowRunId' | 'target'>,
  actions: Props,
) {
  // A targeted decision opens its chat; otherwise a Flow run wins over its chat.
  if (item.chatId && (item.target || !item.flowRunId))
    actions.openChat(item.chatId, item.subChatId ?? undefined, item.target);
  else if (item.flowRunId) actions.openRun(item.flowRunId);
}

const decisionKinds: Record<string, { icon: IconName; tone: Tone }> = {
  question: { icon: 'help', tone: 'accent' },
  permission: { icon: 'shield-checkmark', tone: 'warning' },
};
const reviewKind = { icon: 'eye-outline', tone: 'warning' } as const;

// Reason: Question, permission and review decisions map onto one shared row.
// fallow-ignore-next-line complexity
function DecisionRow({
  item,
  actions,
  separator,
}: {
  item: Decision;
  actions: Props;
  separator: boolean;
}) {
  const actionable = !!(item.chatId || item.flowRunId);
  const kind = decisionKinds[item.key.split(':')[0]] ?? reviewKind;
  const subtitle = [item.context !== item.title ? item.context : '', item.description]
    .filter(Boolean)
    .join(' · ');
  return (
    <Row
      title={item.title}
      separator={separator}
      subtitle={subtitle}
      status={actionable ? undefined : item.status}
      icon={kind.icon}
      tone={kind.tone}
      testID={`queue-row-${item.key}`}
      accessibilityLabel={actionable ? `${item.action}: ${item.title}` : undefined}
      onPress={actionable ? () => openItem(item, actions) : undefined}
    />
  );
}

// Reason: Flow and chat work, running or waiting, share one row.
// fallow-ignore-next-line complexity
function WorkRow({
  item,
  actions,
  separator,
}: {
  item: MobileQueueItem;
  actions: Props;
  separator: boolean;
}) {
  return (
    <Row
      separator={separator}
      title={item.title}
      subtitle={item.summary}
      status={item.status}
      icon={item.flowRunId ? 'git-network-outline' : 'chatbubble-outline'}
      tone={item.section === 'running' ? 'success' : 'neutral'}
      testID={`queue-row-${item.id}`}
      onPress={item.flowRunId || item.chatId ? () => openItem(item, actions) : undefined}
    />
  );
}

function QueueSection({
  title,
  items,
  actions,
}: {
  title: string;
  items: MobileQueueItem[];
  actions: Props;
}) {
  return (
    <Section title={title} count={items.length || undefined}>
      {items.length ? (
        items.map((item, index) => (
          <WorkRow
            key={item.id}
            item={item}
            actions={actions}
            separator={index < items.length - 1}
          />
        ))
      ) : (
        <CardNote>No work running right now.</CardNote>
      )}
    </Section>
  );
}

// Reason: Loading, readiness, search and section states belong to one overview.
// fallow-ignore-next-line complexity
export function Queue({
  openChat,
  openRun,
  resource,
}: Props & { resource: ReturnType<typeof useResource<{ type: 'overview' }>> }) {
  const { data, error } = resource;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<QueueFilter>('all');
  const actions = { openChat, openRun };
  const view = queueView(data, query, filter);
  return (
    <Page title="Work queue" root onRefresh={resource.pull} refreshing={resource.refreshing}>
      <View style={{ gap: 12 }}>
        <SearchField placeholder="Search work" value={query} onChangeText={setQuery} />
        <Segmented
          items={[
            { id: 'all', label: 'All work' },
            { id: 'attention', label: 'Needs you' },
            { id: 'running', label: 'Running' },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </View>
      <ResourceStatus {...resource} />
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {!data.executionReady && (
            <Card style={{ padding: 14 }}>
              <Notice>Keep a Frink window open on your computer to run and resume Flows.</Notice>
            </Card>
          )}
          {view.noMatches ? (
            <Card>
              <CardNote>No matching work in your current queue.</CardNote>
            </Card>
          ) : (
            <>
              {view.showAttention && (
                <Section title="Needs attention" count={view.decisions.length || undefined}>
                  {view.decisions.length ? (
                    view.decisions.map((item, index) => (
                      <DecisionRow
                        key={item.key}
                        item={item}
                        actions={actions}
                        separator={index < view.decisions.length - 1}
                      />
                    ))
                  ) : (
                    <CardNote>You’re all caught up. Nothing needs your input.</CardNote>
                  )}
                </Section>
              )}
              {view.showRunning && (
                <QueueSection title="In progress" items={view.running} actions={actions} />
              )}
              {view.showInbox && (
                <QueueSection title="Up next" items={view.inbox} actions={actions} />
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
}
