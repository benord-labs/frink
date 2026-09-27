import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { MobileMessage } from '../../../../src/shared/types/remote/mobile';
import { useAction, useConnection, useResource } from '../../lib/connection';
import {
  Button,
  Field,
  Icon,
  Label,
  Loading,
  Notice,
  Page,
  Row,
  Section,
} from '../../ui/primitives';
import { useTheme } from '../../ui/theme';
import { glassStyle } from '../../ui/material';
import { PermissionForm, QuestionForm } from './questions';

// Reason: The MVP chat list keeps loading, empty, and error states together.
// fallow-ignore-next-line complexity
export function Chats({
  openChat,
  createChat,
}: {
  openChat: (id: string) => void;
  createChat: () => void;
}) {
  const { data, error, refresh } = useResource({ type: 'chats' });
  return (
    <Page
      title="Chats"
      action={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={createChat}
          style={{
            minHeight: 44,
            minWidth: 44,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="create-outline" />
        </Pressable>
      }
    >
      {error && (
        <>
          <Notice error>{error}</Notice>
          <Button secondary onPress={refresh}>
            Refresh chats
          </Button>
        </>
      )}
      {!data ? (
        !error && <Loading />
      ) : data.length ? (
        data.map((chat) => (
          <Row
            key={chat.id}
            title={chat.name || 'Untitled chat'}
            onPress={() => openChat(chat.id)}
            icon="chatbubble-outline"
          />
        ))
      ) : (
        <Label muted>No conversations yet. Start one with a project on your computer.</Label>
      )}
    </Page>
  );
}
// Reason: Project selection and creation feedback form one bounded MVP flow.
// fallow-ignore-next-line complexity
export function NewChat({
  onBack,
  openChat,
}: {
  onBack: () => void;
  openChat: (id: string, subChatId?: string) => void;
}) {
  const { data: projects, error } = useResource({ type: 'projects' });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const action = useAction();
  return (
    <Page compact title="New chat" onBack={onBack}>
      <Label muted>Choose a project on your computer to start a conversation.</Label>
      {(error || action.error) && <Notice error>{error || action.error}</Notice>}
      <Section title="Choose a project">
        {!projects ? (
          !error && <Loading />
        ) : projects.length ? (
          projects.map((project) => (
            <Row
              key={project.id}
              title={project.name}
              icon={projectId === project.id ? 'checkmark-circle' : 'ellipse-outline'}
              onPress={() => setProjectId(project.id)}
            />
          ))
        ) : (
          <Notice>Add a project in Frink on your computer first.</Notice>
        )}
      </Section>
      <Field
        accessibilityLabel="Chat name"
        placeholder="What are you working on?"
        value={name}
        onChangeText={setName}
        maxLength={100}
      />
      <Button
        disabled={!projectId || !name.trim() || action.busy}
        onPress={async () => {
          if (!projectId) return;
          const chat = await action.run({
            type: 'createChat',
            projectId,
            name: name.trim(),
          });
          if (chat) openChat(chat.chatId, chat.subChatId);
        }}
      >
        {action.busy ? 'Creating…' : 'Create chat'}
      </Button>
    </Page>
  );
}

// Reason: Conversation, approvals, and composer states remain together for the MVP.
// fallow-ignore-next-line complexity
export function Chat({
  id,
  initialSubChatId,
  onBack,
}: {
  id: string;
  initialSubChatId?: string;
  onBack: () => void;
}) {
  const [subChatId, setSubChatId] = useState(initialSubChatId);
  const resource = useResource({ type: 'chat', id, subChatId });
  const { data } = resource;
  const { request } = useConnection();
  const action = useAction();
  const [draft, setDraft] = useState('');
  const [older, setOlder] = useState<MobileMessage[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyDone, setHistoryDone] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const requestId = useRef(Crypto.randomUUID());
  const historyGeneration = useRef(0);
  const t = useTheme();
  useEffect(() => {
    setConfirmStop(false);
  }, [id, subChatId, data?.subChatId, data?.active]);
  const messages = [
    ...new Map(
      [...older, ...(data?.messages ?? [])].map((message) => [message.id, message]),
    ).values(),
  ];
  // Reason: History loading keeps session identity and pagination guards together.
  // fallow-ignore-next-line complexity
  async function loadOlder() {
    if (!data || !messages[0] || loadingHistory) return;
    const generation = historyGeneration.current;
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const page = await request({
        type: 'chat',
        id,
        subChatId: data.subChatId,
        beforeMessageId: messages[0].id,
      });
      if (generation === historyGeneration.current) {
        setOlder((old) => [...page.messages, ...old]);
        setHistoryDone(!page.hasMore);
      }
    } catch (error) {
      if (generation === historyGeneration.current)
        setHistoryError(
          error instanceof Error ? error.message : 'Could not load earlier messages.',
        );
    } finally {
      if (generation === historyGeneration.current) setLoadingHistory(false);
    }
  }
  async function send() {
    if (!data) return;
    const sent = await action.run({
      type: 'sendMessage',
      chatId: id,
      subChatId: data.subChatId,
      text: draft,
      requestId: requestId.current,
    });
    if (sent) {
      setDraft('');
      requestId.current = Crypto.randomUUID();
      resource.refresh();
    }
  }
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Page compact title={data?.chat.name ?? 'Chat'} onBack={onBack}>
        {(resource.error || action.error || historyError) && (
          <>
            <Notice error>{resource.error || action.error || historyError}</Notice>
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
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                {data.subChats.map((sub) => (
                  <Button
                    key={sub.id}
                    secondary={sub.id !== data.subChatId}
                    disabled={action.busy}
                    onPress={() => {
                      historyGeneration.current++;
                      setLoadingHistory(false);
                      setHistoryError(null);
                      setSubChatId(sub.id);
                      setOlder([]);
                      setHistoryDone(false);
                      setDraft('');
                      requestId.current = Crypto.randomUUID();
                    }}
                  >
                    {sub.name || 'Conversation'}
                  </Button>
                ))}
              </ScrollView>
            )}
            {data.hasMore && !historyDone && (
              <Button secondary disabled={loadingHistory} onPress={() => void loadOlder()}>
                {loadingHistory ? 'Loading…' : 'Load earlier messages'}
              </Button>
            )}
            {!messages.length && (
              <Label muted>Start a conversation. Your agent runs on your computer.</Label>
            )}
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {data.questions.map((question) => (
              <QuestionForm key={question.id} prompt={question} onAnswered={resource.refresh} />
            ))}
            {data.error && <Notice error>{data.error}</Notice>}
            {data.permissions.map((permission) => (
              <PermissionForm
                key={permission.requestId}
                prompt={permission}
                onAnswered={resource.refresh}
              />
            ))}
            {data.active && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                <Icon name="ellipse" size={6} color={t.accent} />
                <Label muted size={13}>
                  Frink is working…
                </Label>
              </View>
            )}
          </>
        )}
      </Page>
      {data && (
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: 12,
            gap: 10,
          }}
        >
          {data.active ? (
            confirmStop ? (
              <>
                <Notice>Stopping also ends any active Flow in this chat.</Notice>
                <Button
                  secondary
                  destructive
                  disabled={action.busy}
                  onPress={async () => {
                    if (
                      await action.run({
                        type: 'stopChat',
                        chatId: id,
                        subChatId: data.subChatId,
                      })
                    ) {
                      setConfirmStop(false);
                      resource.refresh();
                    }
                  }}
                >
                  Confirm stop
                </Button>
                <Button secondary disabled={action.busy} onPress={() => setConfirmStop(false)}>
                  Keep running
                </Button>
              </>
            ) : (
              <Button secondary disabled={action.busy} onPress={() => setConfirmStop(true)}>
                Stop response…
              </Button>
            )
          ) : data.questions.length || data.permissions.length ? (
            <Text
              style={{
                textAlign: 'center',
                color: t.muted,
                fontSize: 13,
                lineHeight: 20,
                paddingVertical: 3,
              }}
            >
              Answer above to continue
            </Text>
          ) : (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                gap: 6,
                padding: 5,
                ...glassStyle(t),
                borderRadius: 12,
              }}
            >
              <Field
                accessibilityLabel="Message"
                placeholder="Message Frink…"
                value={draft}
                onChangeText={(text) => {
                  setDraft(text);
                  requestId.current = Crypto.randomUUID();
                }}
                editable={!action.busy}
                multiline
                maxLength={32000}
                style={{
                  flex: 1,
                  maxHeight: 150,
                  minHeight: 44,
                  borderWidth: 0,
                  padding: 10,
                  backgroundColor: 'transparent',
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send message"
                accessibilityState={{
                  disabled:
                    !draft.trim() ||
                    action.busy ||
                    !!data.questions.length ||
                    !!data.permissions.length,
                }}
                disabled={
                  !draft.trim() ||
                  action.busy ||
                  !!data.questions.length ||
                  !!data.permissions.length
                }
                onPress={() => void send()}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: 6,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: t.accent,
                  opacity: !draft.trim() || action.busy ? 0.45 : pressed ? 0.7 : 1,
                })}
              >
                <Icon
                  name={action.busy ? 'hourglass-outline' : 'arrow-up'}
                  color={t.onAccent}
                  size={22}
                />
              </Pressable>
            </View>
          )}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

// Reason: User, assistant and system messages share one role-aware transcript renderer.
// fallow-ignore-next-line complexity
function Message({ message }: { message: MobileMessage }) {
  const t = useTheme();
  const isUser = message.role === 'user';
  const name = isUser ? 'You' : message.role === 'assistant' ? 'Frink' : 'System';
  return (
    <View
      style={{
        alignSelf: isUser ? 'flex-end' : 'stretch',
        maxWidth: isUser ? '92%' : '100%',
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          justifyContent: isUser ? 'flex-end' : 'flex-start',
        }}
      >
        {!isUser && (
          <Icon
            name={message.role === 'assistant' ? 'sparkles-outline' : 'information-circle-outline'}
            size={14}
            color={t.muted}
          />
        )}
        <Label muted size={12}>
          {name}
        </Label>
      </View>
      <View
        style={
          isUser
            ? {
                paddingHorizontal: 14,
                paddingVertical: 11,
                ...glassStyle(t),
                borderRadius: 14,
                borderTopRightRadius: 4,
              }
            : undefined
        }
      >
        <Text selectable style={{ color: t.text, fontSize: 16, lineHeight: 24 }}>
          {message.text || 'Working…'}
        </Text>
      </View>
    </View>
  );
}
