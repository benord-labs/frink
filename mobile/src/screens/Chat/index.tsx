import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import type {
  MobileChatDetail,
  MobileMessage,
} from '../../../../src/shared/types/remote/mobile';
import { useAction, useResource } from '../../lib/connection';
import { useDraft } from '../../lib/drafts';
import { Button, Icon, Label, Loading, Notice } from '../../ui/primitives';
import { Page } from '../../ui/page';
import { Segmented } from '../../ui/segmented';
import { ResourceStatus } from '../../ui/resource-status';
import { useTheme } from '../../ui/theme';
import { Composer } from './Composer';
import { Message } from './Message';
import { PermissionForm, QuestionForm } from './questions';
import { useChatHistory } from './use-chat-history';
import { useTranscriptScroll, type DecisionTarget } from './use-transcript-scroll';

export { Chats } from './Chats';
export { NewChat } from './NewChat';
export type { DecisionTarget } from './use-transcript-scroll';

type Scrolling = ReturnType<typeof useTranscriptScroll>;

// Reason: Working and project context share one header line.
// fallow-ignore-next-line complexity
function ChatContext({ active, projectName }: { active: boolean; projectName?: string }) {
  const t = useTheme();
  if (!active && !projectName) return null;
  return (
    <Text
      numberOfLines={1}
      style={{
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '500',
        color: active ? t.accent : t.muted,
      }}
    >
      {active ? 'Working…' : projectName}
    </Text>
  );
}

function EmptyConversation() {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: 8, paddingTop: 48 }}>
      <Icon name="chatbubbles-outline" size={28} color={t.muted} />
      <Label bold size={17}>
        Start the conversation
      </Label>
      <Label muted size={14} style={{ textAlign: 'center', maxWidth: 260 }}>
        Your agent works on your computer. Replies appear here.
      </Label>
    </View>
  );
}

function Transcript({ messages, scrolling }: { messages: MobileMessage[]; scrolling: Scrolling }) {
  if (!messages.length) return <EmptyConversation />;
  return (
    <View style={{ gap: 20 }}>
      {messages.map((message) => (
        <View
          key={message.id}
          collapsable={false}
          ref={(view) => scrolling.registerMessage(message.id, view)}
          onLayout={() => {
            void scrolling.restorePosition();
          }}
        >
          <Message message={message} />
        </View>
      ))}
    </View>
  );
}

// Questions, a failed response and permission requests, each registered as a scroll target.
function Decisions({
  data,
  scrolling,
  onAnswered,
}: {
  data: MobileChatDetail;
  scrolling: Scrolling;
  onAnswered: () => void;
}) {
  return (
    <>
      {data.questions.map((question) => (
        <View
          key={question.id}
          collapsable={false}
          testID={`decision-question-${question.id}`}
          ref={(view) => scrolling.registerDecision('question', question.id, view)}
          onLayout={() => {
            void scrolling.restorePosition();
          }}
        >
          <QuestionForm prompt={question} onAnswered={onAnswered} />
        </View>
      ))}
      {data.error && <Notice error>{data.error}</Notice>}
      {data.permissions.map((permission) => (
        <View
          key={permission.requestId}
          collapsable={false}
          testID={`decision-permission-${permission.requestId}`}
          ref={(view) => scrolling.registerDecision('permission', permission.requestId, view)}
          onLayout={() => {
            void scrolling.restorePosition();
          }}
        >
          <PermissionForm prompt={permission} onAnswered={onAnswered} />
        </View>
      ))}
    </>
  );
}

function LatestButton({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Latest"
      onPress={onPress}
      style={({ pressed }) => ({
        position: 'absolute',
        bottom: 12,
        alignSelf: 'center',
        height: 34,
        paddingHorizontal: 14,
        borderRadius: 17,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: t.raised,
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon name="arrow-down" size={15} color={t.text} />
      <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '600', color: t.text }}>
        Latest
      </Text>
    </Pressable>
  );
}

function targetStillOpen(data: MobileChatDetail | undefined, target: DecisionTarget | undefined) {
  if (!data || !target) return false;
  return target.type === 'question'
    ? data.questions.some((question) => question.id === target.id)
    : data.permissions.some((permission) => permission.requestId === target.id);
}

// Reason: The screen keeps loading, history, decision and composer states together.
// fallow-ignore-next-line complexity
export function Chat({
  id,
  initialSubChatId,
  decisionTarget,
  onBack,
}: {
  id: string;
  initialSubChatId?: string;
  decisionTarget?: DecisionTarget;
  onBack: () => void;
}) {
  const [subChatId, setSubChatId] = useState(initialSubChatId);
  const activeDecisionTarget =
    subChatId && subChatId !== initialSubChatId ? undefined : decisionTarget;
  const resource = useResource({ type: 'chat', id, subChatId });
  const projects = useResource({ type: 'projects' });
  const { data } = resource;
  const projectName = projects.data?.find((project) => project.id === data?.chat.projectId)?.name;
  const action = useAction();
  const draft = useDraft(
    JSON.stringify(['chat', id, data?.subChatId ?? subChatId ?? 'loading']),
    '',
  );
  const history = useChatHistory(id, data?.messages);
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => {
    setConfirmStop(false);
  }, [id, subChatId, data?.subChatId, data?.active]);
  const targetExists = targetStillOpen(data, activeDecisionTarget);
  const scrolling = useTranscriptScroll(!!data, activeDecisionTarget, targetExists);
  async function send() {
    if (!data) return;
    const sent = await action.run({
      type: 'sendMessage',
      chatId: id,
      subChatId: data.subChatId,
      text: draft.value,
      requestId: draft.requestId,
    });
    if (sent) {
      draft.clear(draft.requestId);
      scrolling.latest();
      resource.refresh();
    }
  }
  async function stop() {
    if (!data) return;
    if (await action.run({ type: 'stopChat', chatId: id, subChatId: data.subChatId })) {
      setConfirmStop(false);
      resource.refresh();
    }
  }
  function switchConversation(next: string) {
    if (action.busy || next === data?.subChatId) return;
    history.reset();
    setSubChatId(next);
    scrolling.reset();
  }
  const error = action.error || history.error;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ flex: 1 }}>
        <Page
          title={data?.chat.name ?? 'Chat'}
          context={<ChatContext active={!!data?.active} projectName={projectName} />}
          onBack={onBack}
          scrollRef={scrolling.scrollRef}
          refreshing={resource.refreshing}
          onRefresh={resource.pull}
          scrollProps={scrolling.scrollProps}
        >
          <ResourceStatus {...resource} />
          {error && (
            <>
              <Notice error>{error}</Notice>
              <Button secondary onPress={resource.refresh}>
                Refresh conversation
              </Button>
            </>
          )}
          {!data ? (
            !resource.error && <Loading />
          ) : (
            <>
              {data.subChats.length > 1 && (
                <Segmented
                  items={data.subChats.map((sub) => ({
                    id: sub.id,
                    label: sub.name || 'Conversation',
                  }))}
                  value={data.subChatId}
                  onChange={switchConversation}
                />
              )}
              {activeDecisionTarget && !targetExists && (
                <Notice>
                  This request has already been resolved on your computer. The conversation is up
                  to date.
                </Notice>
              )}
              {data.hasMore && !history.done && (
                <Button
                  compact
                  secondary
                  icon="time-outline"
                  disabled={history.loading}
                  onPress={() => void history.loadOlder(data.subChatId, scrolling.captureHistory)}
                  style={{ alignSelf: 'center' }}
                >
                  {history.loading ? 'Loading…' : 'Load earlier messages'}
                </Button>
              )}
              <Transcript messages={history.messages} scrolling={scrolling} />
              <Decisions data={data} scrolling={scrolling} onAnswered={resource.refresh} />
            </>
          )}
        </Page>
        {scrolling.showLatest && <LatestButton onPress={scrolling.latest} />}
      </View>
      {data && (data.active || (!data.questions.length && !data.permissions.length)) && (
        <Composer
          active={data.active}
          busy={action.busy}
          value={draft.value}
          onChange={draft.update}
          onSend={() => void send()}
          confirmStop={confirmStop}
          setConfirmStop={setConfirmStop}
          onStop={() => void stop()}
        />
      )}
    </KeyboardAvoidingView>
  );
}
