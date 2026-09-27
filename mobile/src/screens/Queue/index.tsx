import { View } from 'react-native';
import type { MobileOverview, MobileQueueItem } from '../../../../src/shared/types/remote/mobile';
import { useResource } from '../../lib/connection';
import { Button, Label, Loading, Notice, Page, Row, Section } from '../../ui/primitives';
import { useTheme } from '../../ui/theme';

type Props = {
  openChat: (id: string, subChatId?: string) => void;
  openRun: (id: string) => void;
};
type Decision = {
  key: string;
  title: string;
  sourceTitle: string;
  context: string;
  description: string;
  status: string;
  action: string;
  chatId?: string | null;
  subChatId?: string | null;
  flowRunId?: string | null;
};

function collectDecisions(data: MobileOverview): Decision[] {
  const questions: Decision[] = data.questions.map((item) => ({
    key: `question:${item.id}`,
    title: item.questions[0]?.question ?? item.title,
    sourceTitle: item.title,
    context: item.title,
    description: '',
    status: 'awaiting_input',
    action: 'Answer in chat',
    chatId: item.chatId,
    subChatId: item.subChatId,
  }));
  const permissions: Decision[] = data.permissions.map((item) => ({
    key: `permission:${item.requestId}`,
    title: item.title,
    sourceTitle: item.title,
    context: '',
    description: item.description,
    status: 'awaiting_input',
    action: 'Review request',
    chatId: item.chatId,
    subChatId: item.subChatId,
  }));
  const specific = [...questions, ...permissions];
  const remaining: Decision[] = data.queue
    .filter((item) => item.section === 'attention')
    .filter(
      (item) =>
        !specific.some(
          (decision) =>
            item.chatId === decision.chatId &&
            item.subChatId === decision.subChatId &&
            (item.title === decision.sourceTitle || item.title === decision.title),
        ),
    )
    .map((item) => ({
      key: item.id,
      title: item.title,
      sourceTitle: item.title,
      context: item.summary,
      description: '',
      status: item.status,
      action: 'Review work',
      chatId: item.chatId,
      subChatId: item.subChatId,
      flowRunId: item.flowRunId,
    }));
  return [...specific, ...remaining];
}

function openItem(item: Pick<Decision, 'chatId' | 'subChatId' | 'flowRunId'>, actions: Props) {
  if (item.chatId) actions.openChat(item.chatId, item.subChatId ?? undefined);
  else if (item.flowRunId) actions.openRun(item.flowRunId);
}

// Reason: One row maps permission, question and review content into the shared list control.
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
  const t = useTheme();
  const actionable = !!(item.chatId || item.flowRunId);
  const subtitle = [item.context !== item.title ? item.context : '', item.description]
    .filter(Boolean)
    .join('\n');
  return (
    <Row
      title={item.title}
      separator={separator}
      subtitle={subtitle}
      status={actionable ? undefined : item.status}
      icon={
        item.key.startsWith('permission:')
          ? 'shield-checkmark-outline'
          : item.key.startsWith('question:')
            ? 'chatbubble-ellipses-outline'
            : 'document-text-outline'
      }
      testID={`queue-row-${item.key}`}
      accessibilityLabel={actionable ? `${item.action}: ${item.title}` : undefined}
      onPress={actionable ? () => openItem(item, actions) : undefined}
      metadata={
        actionable ? (
          <Label size={13} style={{ color: t.accent }}>
            {item.action}
          </Label>
        ) : undefined
      }
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
          <Row
            key={item.id}
            separator={index < items.length - 1}
            title={item.title}
            subtitle={item.summary}
            status={item.status}
            icon={item.flowRunId ? 'git-network-outline' : 'chatbubble-outline'}
            testID={`queue-row-${item.id}`}
            onPress={
              item.flowRunId
                ? () => actions.openRun(item.flowRunId!)
                : item.chatId
                  ? () => openItem(item, actions)
                  : undefined
            }
          />
        ))
      ) : (
        <Label muted size={14}>
          No work running right now.
        </Label>
      )}
    </Section>
  );
}

// Reason: Loading, readiness, attention and activity states belong to the same queue overview.
// fallow-ignore-next-line complexity
export function Queue({ openChat, openRun }: Props) {
  const { data, error, refresh } = useResource({ type: 'overview' });
  const actions = { openChat, openRun };
  const decisions = data ? collectDecisions(data) : [];
  const running = data?.queue.filter((item) => item.section === 'running') ?? [];
  const inbox = data?.queue.filter((item) => item.section === 'inbox') ?? [];
  return (
    <Page title="Work queue" root>
      {error && (
        <View style={{ gap: 12 }}>
          <Notice error>{error}</Notice>
          <Button compact secondary onPress={refresh}>
            Refresh connection
          </Button>
        </View>
      )}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {!data.executionReady && (
            <Notice>Keep a Frink window open on your computer to run and resume Flows.</Notice>
          )}
          <Section title="Needs attention" count={decisions.length || undefined}>
            {decisions.length ? (
              decisions.map((item, index) => (
                <DecisionRow
                  key={item.key}
                  item={item}
                  actions={actions}
                  separator={index < decisions.length - 1}
                />
              ))
            ) : (
              <Label muted size={14}>
                Nothing needs your input.
              </Label>
            )}
          </Section>
          <QueueSection title="In progress" items={running} actions={actions} />
          {!!inbox.length && <QueueSection title="Up next" items={inbox} actions={actions} />}
        </>
      )}
    </Page>
  );
}
