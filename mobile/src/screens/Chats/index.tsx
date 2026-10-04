import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';
import { ChevronDown, ChevronRight, Folder, Plus, SearchX, SquarePen } from 'lucide-react-native';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { useConnection, useResource } from '../../lib/connection';
import { useOverview } from '../../lib/overview';
import { useWindow } from '../../lib/use-window';
import { useRootNavigation } from '../../navigation/routes';
import { useTabHeader } from '../../navigation/tab-header';
import { Button, IconButton } from '../../ui/button';
import { EmptyState, ListGroup } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { confirmChatDeletion } from '../Chat/confirm';
import { NOT_READY } from '../NewChat/new-chat-options';
import { ChatRow } from './chat-row';
import { chatSections, type ChatSection } from './chat-sections';
import { tell } from '../../ui/tell';
import { useDebounced } from './use-debounced';

// The web preview's tab bar floats over the list; iOS insets for its native tab bar itself.
const TAB_BAR_CLEARANCE = Platform.OS === 'web' ? 96 : space.xl;

export function ChatsScreen() {
  return (
    <Screen>
      <ChatList />
    </Screen>
  );
}

function ChatList() {
  const t = useTheme();
  const root = useRootNavigation();
  const { request } = useConnection();
  const ready = useOverview().data?.executionReady !== false;
  const { query, header } = useTabHeader({
    title: 'Chats',
    search: 'Search chats',
  });
  const search = useDebounced(query, 250);
  const page = useWindow(30);
  // The page a scroll already asked to extend: scroll events outrun the render that loads the next.
  const grown = useRef<unknown>(null);
  // A new search starts from its first page. Resetting during render (not in an effect) means the
  // first request for the new search already asks for that page.
  const [searched, setSearched] = useState(search);
  if (searched !== search) {
    setSearched(search);
    page.reset();
  }
  const chats = useResource(
    { type: 'chats', limit: page.limit, ...(search ? { query: search } : {}) },
    { keep: true },
  );
  const sections = useMemo(() => chatSections(chats.data?.items ?? []), [chats.data]);
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
        refresh();
      } catch (error) {
        // The computer refuses chats a task or Flow owns, and says why.
        tell('Couldn’t delete this chat', error instanceof Error ? error.message : '');
      }
    },
    [request, refresh],
  );

  function empty() {
    if (!chats.data) return chats.error ? null : <ActivityIndicator style={{ padding: 48 }} />;
    if (search)
      return (
        <EmptyState
          icon={SearchX}
          title={`No chats match “${search}”`}
          detail="Try another chat or project name."
        />
      );
    return (
      <EmptyState
        title="No chats yet"
        detail={
          ready ? 'Ask Frink to fix a bug, build a feature or look into a question.' : NOT_READY
        }
        action={
          <Button small disabled={!ready} onPress={() => root.navigate('Chat')}>
            Start a chat
          </Button>
        }
      />
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
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
      <View testID="chats-header">
        {header}
        <ResourceStatus {...chats} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={() => root.navigate('Chat')}
          style={({ pressed }) => ({
            minHeight: 52,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            paddingHorizontal: GUTTER,
            marginTop: space.sm,
            backgroundColor: pressed ? t.pressed : 'transparent',
            opacity: ready ? 1 : 0.4,
          })}
        >
          <SquarePen size={20} color={t.text} />
          <Text variant="row">New chat</Text>
        </Pressable>
      </View>
      {sections.map((section) => (
        <View key={section.key}>
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
          {!collapsed.has(section.key) && (
            <ListGroup>
              {section.data.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  onOpen={open}
                  onDelete={(chat) => void remove(chat)}
                />
              ))}
            </ListGroup>
          )}
        </View>
      ))}
      {sections.length === 0 && empty()}
      <View style={{ paddingTop: space.lg, paddingBottom: TAB_BAR_CLEARANCE }}>
        {chats.stale && sections.length > 0 && (
          <ActivityIndicator accessibilityLabel="Loading more chats" color={t.muted} />
        )}
        {page.atMax && chats.data?.hasMore && (
          <Text
            variant="secondary"
            color="muted"
            style={{ paddingHorizontal: GUTTER, textAlign: 'center' }}
          >
            {`Showing your latest ${page.limit} chats.\nSearch to find older ones.`}
          </Text>
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
        paddingHorizontal: GUTTER,
        paddingTop: space.xl,
        paddingBottom: space.xs,
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
        <Folder size={18} color={t.muted} />
        <Text variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
          {section.title}
        </Text>
        <Chevron size={16} color={t.muted} />
      </Pressable>
      {onCreate && (
        <IconButton
          icon={Plus}
          label={`New chat in ${section.title}`}
          onPress={onCreate}
          disabled={!ready}
        />
      )}
    </View>
  );
}
