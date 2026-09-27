import { View } from 'react-native';
import { useResource } from '../../lib/connection';
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

type Props = {
  openChat: (id: string, subChatId?: string) => void;
  openRun: (id: string) => void;
};
// Reason: The MVP queue presents attention, running, and inbox states together.
// fallow-ignore-next-line complexity
export function Queue({ openChat, openRun }: Props) {
  const { data, error, refresh } = useResource({ type: 'overview' });
  const t = useTheme();
  const attention = data?.queue.filter((item) => item.section === 'attention') ?? [];
  const question = data?.questions[0];
  const permission = data?.permissions[0];
  const first = attention[0];
  const title = question?.questions[0]?.question ?? permission?.title ?? first?.title;
  const chatId = question?.chatId ?? permission?.chatId ?? first?.chatId;
  const subChatId = question?.subChatId ?? permission?.subChatId ?? first?.subChatId;
  // Reason: The first attention item routes to its chat or Flow in one place.
  // fallow-ignore-next-line complexity
  const openFirst = () => {
    if (chatId) openChat(chatId, subChatId ?? undefined);
    else if (first?.flowRunId) openRun(first.flowRunId);
  };
  return (
    <Page title="Work queue" subtitle="A little attention goes a long way.">
      {error && (
        <>
          <Notice error>{error}</Notice>
          <Button secondary onPress={refresh}>
            Refresh connection
          </Button>
        </>
      )}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {!data.executionReady && (
            <Notice>Keep a Frink window open on your computer to run and resume Flows.</Notice>
          )}
          {title ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: 16,
                padding: 20,
                gap: 16,
                backgroundColor: t.surface,
              }}
            >
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <Icon name="chatbubble-ellipses-outline" color={t.warning} size={20} />
                <Status value="Needs your attention" />
              </View>
              <Label size={22} bold>
                {title}
              </Label>
              <Label muted>
                {question?.title ??
                  permission?.description ??
                  first?.summary ??
                  'Review the next step to keep work moving.'}
              </Label>
              <Button disabled={!chatId && !first?.flowRunId} onPress={openFirst}>
                {question ? 'Answer in chat' : permission ? 'Review request' : 'Review work'}
              </Button>
            </View>
          ) : (
            <View style={{ paddingVertical: 20, gap: 12 }}>
              <Icon name="checkmark-circle-outline" size={36} color={t.success} />
              <Label size={22} bold>
                You’re all caught up.
              </Label>
              <Label muted>
                Questions and approvals will appear here when your work needs you.
              </Label>
            </View>
          )}
          <Section title="Needs you">
            {data.questions
              .filter((item) => item.id !== question?.id)
              .map((item) => (
                <Row
                  key={`question:${item.id}`}
                  title={item.questions[0]?.question ?? item.title}
                  subtitle={item.title}
                  status="awaiting_input"
                  onPress={() => openChat(item.chatId, item.subChatId)}
                />
              ))}
            {data.permissions
              .filter((item) => item.requestId !== permission?.requestId || !!question)
              .map((item) => (
                <Row
                  key={`permission:${item.requestId}`}
                  title={item.title}
                  status="awaiting_input"
                  onPress={() => openChat(item.chatId, item.subChatId)}
                />
              ))}
            {attention.map((item) => (
              <Row
                key={item.id}
                title={item.title}
                subtitle={item.summary}
                status={item.status}
                onPress={
                  item.chatId
                    ? () => openChat(item.chatId!, item.subChatId ?? undefined)
                    : item.flowRunId
                      ? () => openRun(item.flowRunId!)
                      : undefined
                }
              />
            ))}
            {!attention.length && !data.questions.length && !data.permissions.length && (
              <Label muted size={14}>
                Nothing waiting for your input.
              </Label>
            )}
          </Section>
          {(['running', 'inbox'] as const).map((section) => (
            <Section key={section} title={section === 'running' ? 'In progress' : 'Up next'}>
              {data.queue
                .filter((item) => item.section === section)
                .map((item) => (
                  <Row
                    key={item.id}
                    title={item.title}
                    subtitle={item.summary}
                    status={item.status}
                    onPress={
                      item.flowRunId
                        ? () => openRun(item.flowRunId!)
                        : item.chatId
                          ? () => openChat(item.chatId!, item.subChatId ?? undefined)
                          : undefined
                    }
                  />
                ))}
              {!data.queue.some((item) => item.section === section) && (
                <Label muted size={14}>
                  {section === 'running' ? 'No work running right now.' : 'The queue is clear.'}
                </Label>
              )}
            </Section>
          ))}
        </>
      )}
    </Page>
  );
}
