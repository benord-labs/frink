import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { ChevronDown, ChevronRight, Plus, SearchX, SquarePen } from 'lucide-react-native';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { useConnection, useResource } from '../../lib/connection';
import { readLastChat } from '../../lib/last-chat';
import { useOverview } from '../../lib/overview';
import { CHATS_PAGE } from '../../lib/resource/first-pages';
import { appStore } from '../../lib/storage';
import { useWindow } from '../../lib/use-window';
import { useRootNavigation } from '../../navigation/routes';
import { useScreenHeader } from '../../navigation/screen-header';
import { closeDeletedChat } from '../../navigation/after-chat-deletion';
import { Button, IconButton } from '../../ui/button';
import { EmptyState } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Segmented } from '../../ui/segmented';
import { Text } from '../../ui/text';
import { space, useTheme } from '../../ui/theme';
import { confirmChatDeletion } from '../Chat/confirm';
import { NOT_READY } from '../NewChat/new-chat-options';
import { ChatRow } from './chat-row';
import { chatSections, recentSections, type ChatSection } from './chat-sections';
import { tell } from '../../ui/tell';
import { useDebounced } from './use-debounced';

const VIEWS = [
  { id: 'recent', label: 'Recent' },
  { id: 'projects', label: 'Projects' },
] as const;
const LIST_INSET = 12;

/** On launch, reopen the conversation that was on screen, once, unless something else opened. */
function useReopenLastChat() {
  const navigation = useRootNavigation();
  const deviceId = useConnection().connection?.deviceId;
  useEffect(() => {
    if (!deviceId) return;
    let left = false;
    // Leaving the list before the saved chat is read means the user already chose where to go.
    const off = navigation.addListener('blur', () => (left = true));
    void readLastChat(appStore, deviceId).then((chat) => {
      off();
      if (chat && !left && navigation.isFocused()) navigation.navigate('Chat', chat);
    });
    return () => {
      left = true;
      off();
    };
    // Only the first mount reopens; later visits to the list stay on the list.
  }, []);
}

/** A new chat waits until the computer can run one. */
function NewChatButton({ ready }: { ready: boolean }) {
  const root = useRootNavigation();
  return (
    <IconButton
      icon={SquarePen}
      label="New chat"
      tone="plain"
      size={44}
      disabled={!ready}
      onPress={() => root.navigate('Chat', undefined)}
    />
  );
}

/** The Chats tab: one history query serves Recent, Projects and search. */
export function ChatsScreen() {
  const root = useRootNavigation();
  const ready = useOverview().data?.executionReady !== false;
  const [view, setView] = useState<'recent' | 'projects'>('recent');
  const { query, header } = useScreenHeader({ title: 'Chats', search: 'Search chats' });
  useReopenLastChat();
  useLayoutEffect(() => {
    const newChat = () => <NewChatButton ready={ready} />;
    root.setOptions({ headerLeft: newChat });
  }, [root, ready]);
  // The list is the screen's first child so the large title can collapse into the bar on scroll.
  return (
    <ChatList query={query} view={view} ready={ready}>
      <View style={{ marginHorizontal: -LIST_INSET }}>
        {header}
        <View style={{ paddingHorizontal: 15, paddingTop: space.sm }}>
          <Segmented items={VIEWS} value={view} onChange={setView} tabs />
        </View>
      </View>
    </ChatList>
  );
}

function ChatList({
  query,
  view,
  ready,
  children,
}: {
  query: string;
  view: 'recent' | 'projects';
  ready: boolean;
  children: ReactNode;
}) {
  const t = useTheme();
  const root = useRootNavigation();
  const { request } = useConnection();
  const search = useDebounced(query, 250);
  const page = useWindow(CHATS_PAGE);
  // Scroll events can outrun the render that loads the next page.
  const grown = useRef<unknown>(null);
  const [searched, setSearched] = useState(search);
  if (searched !== search) {
    setSearched(search);
    page.reset();
  }
  const chats = useResource(
    { type: 'chats', limit: page.limit, ...(search ? { query: search } : {}) },
    { keep: true },
  );
  const sections = useMemo(
    () => (view === 'projects' ? chatSections : recentSections)(chats.data?.items ?? []),
    [chats.data, view],
  );
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const { refresh } = chats;
  const open = useCallback(
    (chat: MobileChatSummary) => root.navigate('Chat', { id: chat.id }),
    [root],
  );
  const remove = useCallback(
    async (chat: MobileChatSummary) => {
      if (!(await confirmChatDeletion(chat.name || 'Untitled chat'))) return;
      try {
        await request({ type: 'deleteChat', chatId: chat.id });
        closeDeletedChat(root, chat.id);
        refresh();
      } catch (error) {
        tell('Couldn’t delete this chat', error instanceof Error ? error.message : '');
      }
    },
    [request, refresh, root],
  );

  return (
    <ScrollView
      testID="chat-list"
      style={{ flex: 1 }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: LIST_INSET, paddingBottom: space.lg }}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={chats.refreshing} onRefresh={chats.pull} />}
      scrollEventThrottle={100}
      onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
        const nearEnd = contentOffset.y + layoutMeasurement.height * 1.6 >= contentSize.height;
        const grow = nearEnd && chats.data?.hasMore && !chats.stale && !page.atMax;
        if (!grow || grown.current === chats.data) return;
        grown.current = chats.data;
        page.more();
      }}
    >
      {children}
      <ResourceStatus {...chats} />
      {sections.map((section) => (
        <View key={section.key}>
          {view === 'projects' ? (
            <ProjectHeader
              section={section}
              collapsed={collapsed.has(section.key)}
              onToggle={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(section.key)) next.delete(section.key);
                  else next.add(section.key);
                  return next;
                })
              }
              onCreate={
                section.projectId
                  ? () => root.navigate('Chat', { projectId: section.projectId! })
                  : undefined
              }
              ready={ready}
            />
          ) : (
            <Text
              variant="secondary"
              color="muted"
              style={{ paddingHorizontal: 10, paddingTop: space.lg, paddingBottom: space.xs }}
            >
              {section.title}
            </Text>
          )}
          {(view === 'recent' || !collapsed.has(section.key)) &&
            section.data.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                onOpen={open}
                onDelete={(chat) => void remove(chat)}
              />
            ))}
        </View>
      ))}
      {!chats.data && !chats.error && <ActivityIndicator style={{ padding: 48 }} />}
      {chats.data &&
        sections.length === 0 &&
        (search ? (
          <EmptyState
            icon={SearchX}
            title={`No chats match “${search}”`}
            detail="Try another chat or project name."
          />
        ) : (
          <EmptyState
            title="No chats yet"
            detail={
              ready ? 'Ask Frink to fix a bug, build a feature or look into a question.' : NOT_READY
            }
            action={
              <Button disabled={!ready} onPress={() => root.navigate('Chat', undefined)}>
                Start a chat
              </Button>
            }
          />
        ))}
      <View style={{ paddingTop: space.lg }}>
        {chats.stale && sections.length > 0 && (
          <ActivityIndicator accessibilityLabel="Loading more chats" color={t.muted} />
        )}
        {page.atMax && chats.data?.hasMore && (
          <Text
            variant="secondary"
            color="muted"
            style={{ textAlign: 'center' }}
          >{`Showing your latest ${page.limit} chats.\nSearch to find older ones.`}</Text>
        )}
      </View>
    </ScrollView>
  );
}

function ProjectHeader({
  section,
  collapsed,
  onToggle,
  onCreate,
  ready,
}: {
  section: ChatSection;
  collapsed: boolean;
  onToggle: () => void;
  onCreate?: () => void;
  ready: boolean;
}) {
  const t = useTheme();
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingTop: space.sm,
        gap: space.sm,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${section.title}, project`}
        accessibilityState={{ expanded: !collapsed }}
        onPress={onToggle}
        style={{
          flex: 1,
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
        }}
      >
        <Text variant="secondary" style={{ flexShrink: 1, fontWeight: '600' }}>
          {section.title}
        </Text>
        <Chevron size={15} color={t.muted} />
      </Pressable>
      {onCreate && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New chat in ${section.title}`}
          accessibilityState={{ disabled: !ready }}
          onPress={onCreate}
          disabled={!ready}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? t.pressed : 'transparent',
            opacity: ready ? 1 : 0.4,
          })}
        >
          <Plus size={18} color={t.muted} />
        </Pressable>
      )}
    </View>
  );
}
