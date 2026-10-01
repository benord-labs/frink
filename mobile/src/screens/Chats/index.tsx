import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, SectionList, View } from 'react-native';
import { MessageSquare, SearchX } from 'lucide-react-native';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { useConnection, useResource } from '../../lib/connection';
import { useOverview } from '../../lib/overview';
import { useWindow } from '../../lib/use-window';
import { useRootNavigation } from '../../navigation/routes';
import { useTabHeader } from '../../navigation/tab-header';
import { Button } from '../../ui/button';
import { EmptyState, RowSeparator, SectionHeader } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { confirmChatDeletion } from '../Chat/confirm';
import { NOT_READY } from '../NewChat/new-chat-options';
import { ChatRow } from './chat-row';
import { chatSections } from './chat-sections';
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
    compose: true,
    composeDisabled: !ready,
  });
  const search = useDebounced(query, 250);
  const page = useWindow(30);
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
        icon={MessageSquare}
        title="No chats yet"
        detail={
          ready
            ? 'Ask Frink to fix a bug, build a feature or look into a question.'
            : NOT_READY
        }
        action={
          <Button small disabled={!ready} onPress={() => root.navigate('NewChat')}>
            Start a chat
          </Button>
        }
      />
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(chat) => chat.id}
      renderItem={({ item }) => (
        <ChatRow chat={item} onOpen={open} onDelete={(chat) => void remove(chat)} />
      )}
      renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
      ItemSeparatorComponent={RowSeparator}
      stickySectionHeadersEnabled={false}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshing={chats.refreshing}
      onRefresh={chats.pull}
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (chats.data?.hasMore && !chats.stale && !page.atMax) page.more();
      }}
      ListHeaderComponent={
        <View testID="chats-header">
          {header}
          <ResourceStatus {...chats} />
        </View>
      }
      ListEmptyComponent={empty()}
      ListFooterComponent={
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
      }
    />
  );
}
