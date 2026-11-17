import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { ArrowDown, History, MessageSquare } from 'lucide-react-native';
import type { MobileChatDetail, MobileMessage } from '@frink/shared/types/remote/mobile';
import { EmptyState } from '../../ui/list';
import { GlassSurface } from '../../ui/material';
import { Text } from '../../ui/text';
import { radius, space, useTheme } from '../../ui/theme';
import { Message } from './Message';
import { Note } from './note';
import { PermissionForm, QuestionForm } from './questions';
import type { useChatHistory } from './use-chat-history';
import type { useTranscriptScroll } from './use-transcript-scroll';

type Scrolling = ReturnType<typeof useTranscriptScroll>;
type History = ReturnType<typeof useChatHistory>;

/** Wraps a transcript item so the scroll keeper can measure it and settle after it lays out. */
function Measured({
  testID,
  register,
  scrolling,
  children,
}: {
  testID?: string;
  register: (view: View | null) => void;
  scrolling: Scrolling;
  children: ReactNode;
}) {
  return (
    <View
      testID={testID}
      collapsable={false}
      ref={register}
      onLayout={() => void scrolling.restorePosition()}
    >
      {children}
    </View>
  );
}

function EarlierButton({ history, onPress }: { history: History; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Load earlier messages"
      accessibilityState={{ busy: history.loading }}
      disabled={history.loading}
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 32,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        backgroundColor: t.fill,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {history.loading ? (
        <ActivityIndicator size="small" color={t.muted} />
      ) : (
        <History size={14} color={t.muted} strokeWidth={2} />
      )}
      <Text variant="secondary" color="secondary" style={{ fontWeight: '500' }}>
        {history.loading ? 'Loading…' : 'Earlier messages'}
      </Text>
    </Pressable>
  );
}

export function Transcript({
  data,
  messages,
  history,
  scrolling,
  targetResolved,
  onAnswered,
}: {
  data: MobileChatDetail;
  messages: MobileMessage[];
  history: History;
  scrolling: Scrolling;
  targetResolved: boolean;
  onAnswered: () => void;
}) {
  const empty = !messages.length && !data.questions.length && !data.permissions.length;
  const latestReply = messages.findLast((message) => message.role !== 'user')?.id;
  const plan = data.pendingPlanId
    ? {
        id: data.pendingPlanId,
        chatId: data.chat.id,
        subChatId: data.subChatId,
        onDecided: onAnswered,
      }
    : undefined;
  return (
    <View style={{ gap: 28 }}>
      {targetResolved && (
        <Note>This was already answered on your Mac. The chat is up to date.</Note>
      )}
      {data.hasMore && !history.done && (
        <EarlierButton
          history={history}
          onPress={() => void history.loadOlder(data.subChatId, scrolling.captureHistory)}
        />
      )}
      {history.error && <Note error>{history.error}</Note>}
      {empty && (
        <EmptyState
          icon={MessageSquare}
          title="No messages yet"
          detail="Send a message and Frink gets to work on your Mac."
        />
      )}
      {messages.map((message) => (
        <Measured
          key={message.id}
          register={(view) => scrolling.registerMessage(message.id, view)}
          scrolling={scrolling}
        >
          <Message message={message} latest={message.id === latestReply} plan={plan} />
        </Measured>
      ))}
      {data.error && <Note error>{data.error}</Note>}
      {data.questions.map((question) => (
        <Measured
          key={question.id}
          testID={`decision-question-${question.id}`}
          register={(view) => scrolling.registerDecision('question', question.id, view)}
          scrolling={scrolling}
        >
          <QuestionForm prompt={question} onAnswered={onAnswered} />
        </Measured>
      ))}
      {data.permissions.map((permission) => (
        <Measured
          key={permission.requestId}
          testID={`decision-permission-${permission.requestId}`}
          register={(view) => scrolling.registerDecision('permission', permission.requestId, view)}
          scrolling={scrolling}
        >
          <PermissionForm prompt={permission} onAnswered={onAnswered} />
        </Measured>
      ))}
    </View>
  );
}

/** Floats above the composer once the reader has scrolled away from the newest message.
 *  The arrow sits in a View: a bare svg paints under the web preview's blur layer. */
export function LatestChip({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Latest"
      onPress={onPress}
      style={({ pressed }) => ({ alignSelf: 'center', opacity: pressed ? 0.8 : 1 })}
    >
      <GlassSurface
        style={{
          height: 36,
          paddingHorizontal: 14,
          borderRadius: radius.pill,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <View>
          <ArrowDown size={15} color={t.text} strokeWidth={2.2} />
        </View>
        <Text variant="secondary" style={{ fontWeight: '600' }}>
          Latest
        </Text>
      </GlassSurface>
    </Pressable>
  );
}
