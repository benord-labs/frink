import { Pressable, View } from 'react-native';
import type { MobileOverview, MobileQueueItem } from '../../../../src/shared/types/remote/mobile';
import { useResource } from '../../lib/connection';
import { glassStyle } from '../../ui/material';
import { Button, Icon, Label, Loading, Notice, Page, Section, Status } from '../../ui/primitives';
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

function QueueSection({
  title,
  empty,
  items,
  actions,
}: {
  title: string;
  empty: string;
  items: MobileQueueItem[];
  actions: Props;
}) {
  const t = useTheme();
  return (
    <Section title={title}>
      {items.length ? (
        <View>
          {items.map(
            // Reason: Each queue row reflects action availability, source, summary and status.
            // fallow-ignore-next-line complexity
            (item, index) => {
              const actionable = !!(item.chatId || item.flowRunId);
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole={actionable ? 'button' : undefined}
                  disabled={!actionable}
                  onPress={() =>
                    item.flowRunId ? actions.openRun(item.flowRunId) : openItem(item, actions)
                  }
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    minHeight: 64,
                    borderTopWidth: index ? 1 : 0,
                    borderColor: t.border,
                    opacity: pressed ? 0.65 : 1,
                  })}
                >
                  <Icon
                    name={item.flowRunId ? 'git-branch-outline' : 'chatbubble-outline'}
                    size={18}
                    color={t.muted}
                  />
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <Label bold size={15}>
                      {item.title}
                    </Label>
                    {!!item.summary && (
                      <Label muted size={14}>
                        {item.summary}
                      </Label>
                    )}
                    <Status value={item.status} />
                  </View>
                  {actionable && <Icon name="chevron-forward" size={15} color={t.muted} />}
                </Pressable>
              );
            },
          )}
        </View>
      ) : (
        <Label muted size={14}>
          {empty}
        </Label>
      )}
    </Section>
  );
}

// Reason: The focused decision conditionally shows context, details and its available action.
// fallow-ignore-next-line complexity
function DecisionFocus({ item, actions }: { item: Decision; actions: Props }) {
  const t = useTheme();
  const actionable = !!(item.chatId || item.flowRunId);
  return (
    <View style={[glassStyle(t), { borderRadius: 12, overflow: 'hidden' }]}>
      <View style={{ padding: 14, paddingBottom: actionable ? 0 : 14, gap: 8 }}>
        {!!item.context && item.context !== item.title && (
          <Label muted size={13}>
            {item.context}
          </Label>
        )}
        <Label size={16} style={{ lineHeight: 23 }}>
          {item.title}
        </Label>
        {!!item.description && (
          <Label muted size={14}>
            {item.description}
          </Label>
        )}
      </View>
      {actionable && (
        <View
          style={{
            paddingHorizontal: 14,
            paddingTop: 8,
            paddingBottom: 10,
            alignItems: 'flex-end',
            minHeight: 54,
            justifyContent: 'center',
          }}
        >
          <Button compact style={{ alignSelf: 'flex-end' }} onPress={() => openItem(item, actions)}>
            {item.action}
          </Button>
        </View>
      )}
    </View>
  );
}

// Reason: The decision row conditionally shows context, details and a supported navigation action.
// fallow-ignore-next-line complexity
function DecisionRow({ item, actions }: { item: Decision; actions: Props }) {
  const t = useTheme();
  const actionable = !!(item.chatId || item.flowRunId);
  return (
    <Pressable
      accessibilityRole={actionable ? 'button' : undefined}
      disabled={!actionable}
      onPress={() => openItem(item, actions)}
      style={({ pressed }) => ({
        minHeight: 64,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderColor: t.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <Label bold size={15}>
          {item.title}
        </Label>
        {!!item.context && item.context !== item.title && (
          <Label muted size={14}>
            {item.context}
          </Label>
        )}
        {!!item.description && (
          <Label muted size={13}>
            {item.description}
          </Label>
        )}
        <Status value={item.status} />
      </View>
      {actionable && <Icon name="chevron-forward" size={16} color={t.muted} />}
    </Pressable>
  );
}

// Reason: Queue loading, readiness, decisions and empty states form one bounded mobile screen.
// fallow-ignore-next-line complexity
export function Queue({ openChat, openRun }: Props) {
  const { data, error, refresh } = useResource({ type: 'overview' });
  const t = useTheme();
  const actions = { openChat, openRun };
  const decisions = data ? collectDecisions(data) : [];
  const running = data?.queue.filter((item) => item.section === 'running') ?? [];
  const inbox = data?.queue.filter((item) => item.section === 'inbox') ?? [];
  return (
    <Page title="Work queue">
      {error && (
        <View style={{ gap: 12 }}>
          <Notice error>{error}</Notice>
          <Button compact secondary icon="refresh-outline" onPress={refresh}>
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
          {decisions.length ? (
            <Section title="Needs attention">
              <DecisionFocus item={decisions[0]} actions={actions} />
              {decisions.length > 1 && (
                <View>
                  {decisions.slice(1).map((item) => (
                    <DecisionRow key={item.key} item={item} actions={actions} />
                  ))}
                </View>
              )}
            </Section>
          ) : (
            <View
              style={{ flexDirection: 'row', gap: 11, alignItems: 'center', paddingVertical: 8 }}
            >
              <Icon name="checkmark-circle-outline" size={23} color={t.muted} />
              <View style={{ flex: 1, gap: 4 }}>
                <Label bold size={16}>
                  Nothing needs your input
                </Label>
                <Label muted size={13}>
                  Questions and approvals appear here.
                </Label>
              </View>
            </View>
          )}
          <QueueSection
            title="In progress"
            empty="No work running right now."
            items={running}
            actions={actions}
          />
          {inbox.length ? (
            <QueueSection title="Up next" empty="No queued work." items={inbox} actions={actions} />
          ) : (
            <View style={{ borderTopWidth: 1, borderColor: t.border, paddingTop: 16 }}>
              <Label muted size={13}>
                No queued work.
              </Label>
            </View>
          )}
        </>
      )}
    </Page>
  );
}
