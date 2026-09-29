import { useRoute, type RouteProp } from '@react-navigation/native';
import { useAnimatedHeaderHeight } from '@react-navigation/native-stack';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MobileActivity } from '@frink/shared/types/remote/mobile';
import { useResource } from '../../lib/connection';
import { useDraft } from '../../lib/drafts';
import { useRootNavigation, type DecisionTarget, type RootRoutes } from '../../navigation/routes';
import { GlassSurface } from '../../ui/material';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { chatPollInterval, decisionStillOpen, showsComposer } from './chat-state';
import { Composer, useComposerAttachments, useComposerState } from './Composer';
import { SubChatTabs, useChatHeader } from './header';
import { LatestChip, Transcript } from './transcript';
import { useChatActions } from './use-chat-actions';
import { useChatHistory } from './use-chat-history';
import { useTranscriptScroll } from './use-transcript-scroll';
import { useTurnClock } from './use-turn-clock';

const ios = Platform.OS === 'ios';

/** The home-indicator gap only applies while the keyboard is down. */
function useKeyboardShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!ios) return;
    const show = Keyboard.addListener('keyboardWillShow', () => setShown(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

/** Busy chats poll faster; the interval follows the last activity the computer reported. */
function useChatResource(id: string, subChatId: string | undefined) {
  const [activity, setActivity] = useState<MobileActivity>();
  const resource = useResource(
    { type: 'chat', id, subChatId },
    { interval: chatPollInterval(activity) },
  );
  const latest = resource.data?.activity;
  useEffect(() => setActivity(latest), [latest]);
  return resource;
}

/** Only whether the Mac can run chats is needed here, so the overview's lists stay one row long. */
function useExecutionReady() {
  const overview = useResource(
    { type: 'overview', limits: { attention: 1, running: 1, inbox: 1 } },
    { interval: 10_000 },
  );
  return overview.data?.executionReady ?? true;
}

/**
 * What must stay in sight while the transcript follows the newest message: the offline banner and
 * the conversation tabs. Pinned under the navigation bar on a glass band the transcript scrolls
 * beneath; `edgeRef` marks where readable space starts, for scrolling to a question.
 */
function PinnedStrip({
  edgeRef,
  onHeight,
  children,
}: {
  edgeRef: RefObject<View | null>;
  onHeight: (height: number) => void;
  children: ReactNode;
}) {
  // Only iOS draws its header over the screen; elsewhere the screen starts below it.
  const headerHeight = useAnimatedHeaderHeight();
  return (
    <Animated.View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, top: ios ? headerHeight : 0 }}
    >
      <View
        ref={edgeRef}
        collapsable={false}
        pointerEvents="box-none"
        onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      >
        {children && (
          <GlassSurface
            style={{
              borderRadius: 0,
              borderTopWidth: 0,
              borderLeftWidth: 0,
              borderRightWidth: 0,
              paddingBottom: space.xs,
            }}
          >
            {children}
          </GlassSurface>
        )}
      </View>
    </Animated.View>
  );
}

function ChatView({
  id,
  initialSubChatId,
  decisionTarget,
}: {
  id: string;
  initialSubChatId?: string;
  decisionTarget?: DecisionTarget;
}) {
  const t = useTheme();
  const navigation = useRootNavigation();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  const [composerHeight, setComposerHeight] = useState(0);
  const [subChatId, setSubChatId] = useState(initialSubChatId);
  const target = subChatId && subChatId !== initialSubChatId ? undefined : decisionTarget;
  const resource = useChatResource(id, subChatId);
  const { data } = resource;
  const [stripHeight, setStripHeight] = useState(0);
  const executionReady = useExecutionReady();
  const kind = data?.kind;
  const flowRun = kind === 'flow';
  const projects = useResource({ type: 'projects' }, { interval: 60_000 });
  const project = projects.data?.find((entry) => entry.id === data?.chat.projectId)?.name;
  const draft = useDraft(
    JSON.stringify(['chat', id, data?.subChatId ?? subChatId ?? 'loading']),
    '',
  );
  const history = useChatHistory(id, data?.messages);
  const composerState = useComposerState(id, data?.subChatId);
  const attachments = useComposerAttachments(
    data ? { chatId: id, subChatId: data.subChatId } : null,
  );
  const targetOpen = decisionStillOpen(data, target);
  const scrolling = useTranscriptScroll(!!data, target, targetOpen);
  const tabs = !!data && data.subChats.length > 1;
  // The strip's height is the transcript's top inset; when the banner comes or goes, keep the
  // reader's place (or the newest message in view) rather than letting the text jump.
  const { restorePosition } = scrolling;
  useEffect(() => void restorePosition(), [stripHeight]);
  const clock = useTurnClock(data?.activity, `${id}:${data?.subChatId}`, resource.updatedAt);
  const actions = useChatActions({
    chatId: id,
    data,
    draft,
    attachments,
    flowRun,
    refresh: resource.refresh,
    onSent: () => {
      if (data?.activity === 'idle') clock.started();
      scrolling.latest();
    },
    onDeleted: () => navigation.goBack(),
  });
  useChatHeader(
    { name: data?.chat.name ?? '', kind, project, activity: data?.activity, elapsed: clock.elapsed },
    data ? actions.remove : null,
  );
  function switchConversation(next: string) {
    if (actions.busy || next === data?.subChatId) return;
    history.reset();
    setSubChatId(next);
    scrolling.reset();
  }
  const composer = data && showsComposer(data);
  const bottom = keyboard ? space.sm : Math.max(insets.bottom, space.sm);
  const note =
    actions.note ?? (composerState.error ? { text: composerState.error, error: true } : null);
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={ios ? 'padding' : undefined}>
      <ScrollView
        ref={scrolling.scrollRef}
        {...scrolling.scrollProps}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={resource.refreshing}
            onRefresh={resource.pull}
            tintColor={t.muted}
          />
        }
        contentContainerStyle={{
          paddingTop: stripHeight,
          // iOS already insets the scroll view by the home indicator ("automatic" adjustment).
          paddingBottom: (composer ? composerHeight : 0) + space.xl + (ios ? space.sm : bottom),
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 720,
            alignSelf: 'center',
            paddingHorizontal: GUTTER,
            paddingTop: space.lg,
          }}
        >
          {data ? (
            <Transcript
              data={data}
              messages={history.messages}
              history={history}
              scrolling={scrolling}
              targetResolved={!!target && !targetOpen}
              onAnswered={resource.refresh}
            />
          ) : (
            !resource.error && <ActivityIndicator color={t.muted} style={{ paddingTop: 120 }} />
          )}
        </View>
      </ScrollView>
      <PinnedStrip edgeRef={scrolling.edgeRef} onHeight={setStripHeight}>
        {(resource.error || tabs) && (
          <>
            <ResourceStatus {...resource} />
            {data && <SubChatTabs data={data} onChange={switchConversation} />}
          </>
        )}
      </PinnedStrip>
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, bottom, paddingHorizontal: 10, gap: 10 }}
      >
        {scrolling.showLatest && <LatestChip onPress={scrolling.latest} />}
        {composer && (
          <View
            testID="composer"
            onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
            style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}
          >
            <Composer
              activity={data.activity}
              executionReady={executionReady}
              flowRun={flowRun}
              busy={actions.busy}
              note={note}
              value={draft.value}
              onChange={draft.update}
              onSend={actions.submit}
              onStop={actions.stop}
              composer={composerState.composer}
              attachments={attachments}
              onUpdate={(patch) => composerState.change({ type: 'updateComposer', patch })}
              onMode={(mode) => composerState.change({ type: 'setMode', mode })}
              onAccount={(accountId) => composerState.change({ type: 'setAccount', accountId })}
            />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/** A conversation pushed above the tabs: native header, transcript and floating composer. */
export function ChatScreen() {
  const { params } = useRoute<RouteProp<RootRoutes, 'Chat'>>();
  return (
    <Screen atmosphere>
      <ChatView
        key={params.id}
        id={params.id}
        initialSubChatId={params.subChatId}
        decisionTarget={params.decisionTarget}
      />
    </Screen>
  );
}
