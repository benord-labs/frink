import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Inbox,
  Plus,
  SearchX,
  SquarePen,
} from 'lucide-react-native';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { useConnection, useResource } from '../../lib/connection';
import { useOverview } from '../../lib/overview';
import { useWindow } from '../../lib/use-window';
import { useRootNavigation } from '../../navigation/routes';
import { afterChatDeletion } from '../../navigation/after-chat-deletion';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { SearchField } from '../../ui/search-field';
import { Segmented } from '../../ui/segmented';
import { Text } from '../../ui/text';
import { radius, space, useTheme } from '../../ui/theme';
import { confirmChatDeletion } from '../Chat/confirm';
import { NOT_READY } from '../NewChat/new-chat-options';
import { needsYouCount } from '../Queue/queue-view';
import { ChatRow } from './chat-row';
import { chatSections, recentSections, type ChatSection } from './chat-sections';
import { tell } from '../../ui/tell';
import { useDebounced } from './use-debounced';

const VIEWS = [
  { id: 'recent', label: 'Recent' },
  { id: 'projects', label: 'Projects' },
] as const;

/** One history query serves Recent, Projects and search in the retained conversation drawer. */
export function ChatsScreen({ selectedId }: { selectedId?: string }) {
  const t = useTheme();
  const root = useRootNavigation();
  const overview = useOverview();
  const ready = overview.data?.executionReady !== false;
  const needsYou = needsYouCount(overview.data);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'recent' | 'projects'>('recent');
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ paddingHorizontal: 15, gap: space.sm }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search chats" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={() => root.popTo('Chat', undefined)}
          style={({ pressed }) => ({
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 10,
            borderRadius: radius.sm,
            backgroundColor: pressed ? t.pressed : 'transparent',
            opacity: ready ? 1 : 0.4,
          })}
        >
          <SquarePen size={20} color={t.text} />
          <Text variant="row">New chat</Text>
        </Pressable>
        <View
          accessibilityLabel="Work"
          style={{
            borderWidth: 1,
            borderColor: t.borderSubtle,
            borderRadius: radius.md,
            backgroundColor: t.fill,
            overflow: 'hidden',
          }}
        >
          {(
            [
              { name: 'Queue', icon: Inbox },
              { name: 'Flows', icon: GitBranch },
            ] as const
          ).map(({ name, icon: Icon }, index) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={
                name === 'Queue' && needsYou ? `Queue, ${needsYou} need you` : name
              }
              onPress={() => root.replace(name)}
              style={({ pressed }) => ({
                minHeight: 44,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: 11,
                borderTopWidth: index ? 1 : 0,
                borderTopColor: t.borderSubtle,
                backgroundColor: pressed ? t.pressed : 'transparent',
              })}
            >
              <Icon size={19} color={t.secondary} />
              <Text variant="secondary" style={{ flex: 1 }}>
                {name}
              </Text>
              {name === 'Queue' && needsYou > 0 ? (
                <Text
                  variant="secondary"
                  color="attention"
                  style={{
                    paddingHorizontal: 6,
                    borderRadius: 5,
                    backgroundColor: t.attentionSoft,
                  }}
                >
                  {needsYou}
                </Text>
              ) : (
                <ChevronRight size={16} color={t.muted} />
              )}
            </Pressable>
          ))}
        </View>
        <Segmented items={VIEWS} value={view} onChange={setView} tabs />
      </View>
      <ChatList query={query} view={view} selectedId={selectedId} ready={ready} />
    </View>
  );
}

function ChatList({
  query,
  view,
  selectedId,
  ready,
}: {
  query: string;
  view: 'recent' | 'projects';
  selectedId?: string;
  ready: boolean;
}) {
  const t = useTheme();
  const root = useRootNavigation();
  const { request } = useConnection();
  const search = useDebounced(query, 250);
  const page = useWindow(30);
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
    (chat: MobileChatSummary) => root.popTo('Chat', { id: chat.id }),
    [root],
  );
  const remove = useCallback(
    async (chat: MobileChatSummary) => {
      if (!(await confirmChatDeletion(chat.name || 'Untitled chat'))) return;
      try {
        await request({ type: 'deleteChat', chatId: chat.id });
        root.reset(afterChatDeletion(root.getState(), chat.id));
        refresh();
      } catch (error) {
        tell('Couldn’t delete this chat', error instanceof Error ? error.message : '');
      }
    },
    [request, refresh, root],
  );

  return (
    <ScrollView
      testID="history-list"
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: space.lg }}
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
                  ? () => root.popTo('Chat', { projectId: section.projectId! })
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
                selected={chat.id === selectedId}
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
              <Button disabled={!ready} onPress={() => root.popTo('Chat', undefined)}>
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
