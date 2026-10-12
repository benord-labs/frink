import {
  StackActions,
  useNavigationState,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type {
  NativeStackHeaderItem,
  NativeStackNavigationOptions,
} from '@react-navigation/native-stack';
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, View } from 'react-native';
import { ChevronDown, Inbox, Menu, SquarePen, Trash2, type LucideIcon } from 'lucide-react-native';
import type { MobileActivity, MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { useOverview } from '../../lib/overview';
import { useRootNavigation, type RootRoutes } from '../../navigation/routes';
import { IconButton } from '../../ui/button';
import { PulseDot } from '../../ui/glyphs';
import { Text } from '../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../ui/theme';
import { needsYouCount } from '../Queue/queue-view';
import { Sheet } from './Composer/sheet';

function activityWords(activity: MobileActivity, elapsed: string): string | null {
  if (activity === 'running') return elapsed ? `Running ${elapsed}` : 'Running';
  if (activity === 'background') return 'Background';
  return null;
}

export type TitleInfo = {
  name: string;
  kind: 'chat' | 'flow' | undefined;
  project: string | undefined;
  activity: MobileActivity | undefined;
  elapsed: string;
};

/**
 * The title's live values, outside the navigation options: the clock ticks every second while
 * Frink works, and re-setting options that often would rebuild the native header (and its menu).
 */
function createTitleStore() {
  let value: TitleInfo = {
    name: '',
    kind: undefined,
    project: undefined,
    activity: undefined,
    elapsed: '',
  };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: TitleInfo) {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
type TitleStore = ReturnType<typeof createTitleStore>;

function Dot() {
  return (
    <Text variant="label" color="muted" style={{ fontWeight: '500' }}>
      ·
    </Text>
  );
}

// Reason: Header states have browser tests; CRAP estimates zero without their coverage map.
// fallow-ignore-next-line complexity
function ChatSubtitle({ kind, project, activity, elapsed }: Omit<TitleInfo, 'name'>) {
  const t = useTheme();
  const state = activity ? activityWords(activity, elapsed) : null;
  const words = [kind === 'flow' && 'Flow', project].filter(Boolean);
  if (!words.length && !state) return null;
  return (
    <View testID="chat-subtitle" style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {words.length > 0 && (
        <Text
          variant="label"
          color="muted"
          numberOfLines={1}
          style={{ fontWeight: '500', flexShrink: 1 }}
        >
          {words.join(' · ')}
        </Text>
      )}
      {words.length > 0 && state && <Dot />}
      {activity === 'running' && <PulseDot color={t.accent} size={6} />}
      {state && (
        <Text
          variant="label"
          color={activity === 'running' ? 'accent' : 'secondary'}
          style={{ fontWeight: '500' }}
        >
          {state}
        </Text>
      )}
    </View>
  );
}

/** The conversation title opens its actions; project and live status stay visible underneath. */
function ChatTitle({
  store,
  onDelete,
}: {
  store: TitleStore;
  onDelete?: () => Promise<void> | undefined;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const title = useSyncExternalStore(store.subscribe, store.get);
  const { name } = title;
  return (
    <>
      <Pressable
        accessible
        accessibilityRole={onDelete ? 'button' : 'header'}
        accessibilityLabel={onDelete ? 'Chat options' : name}
        accessibilityHint={onDelete ? `${name}. Opens conversation actions.` : undefined}
        disabled={!onDelete}
        onPress={() => setOpen(true)}
        style={{ justifyContent: 'center', minHeight: 44, maxWidth: 210 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
            {name}
          </Text>
          {onDelete && <ChevronDown size={12} color={t.muted} />}
        </View>
        <ChatSubtitle {...title} />
      </Pressable>
      {open && (
        <Sheet title="Chat options" onClose={() => setOpen(false)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete chat"
            onPress={async () => {
              await onDelete?.();
              setOpen(false);
            }}
            style={({ pressed }) => ({
              minHeight: 52,
              paddingHorizontal: GUTTER,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Trash2 size={20} color={t.danger} />
            <Text color="danger">Delete chat</Text>
          </Pressable>
        </Sheet>
      )}
    </>
  );
}

function HeaderAction({
  label,
  icon: Icon,
  testID,
  count = 0,
  onPress,
}: {
  label: string;
  icon: LucideIcon;
  testID: string;
  count?: number;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <IconButton
      testID={testID}
      icon={Icon}
      label={label}
      tone="plain"
      size={44}
      accessibilityHint={count ? `${count} items need you` : undefined}
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
    >
      {count > 0 && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 4,
            bottom: 3,
            minWidth: 18,
            minHeight: 18,
            paddingHorizontal: 3,
            borderRadius: 10,
            backgroundColor: t.attentionSolid,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="label" maxFontSizeMultiplier={1.2} style={{ color: '#FFFFFF' }}>
            {count > 99 ? '99+' : count}
          </Text>
        </View>
      )}
    </IconButton>
  );
}

function ConversationActions({ onNewChat }: { onNewChat?: () => void }) {
  const navigation = useRootNavigation();
  const count = needsYouCount(useOverview().data);
  return (
    <View style={{ flexDirection: 'row' }}>
      {onNewChat && (
        <HeaderAction label="New chat" icon={SquarePen} testID="new-chat" onPress={onNewChat} />
      )}
      <HeaderAction
        label="Queue"
        icon={Inbox}
        testID="queue-open"
        count={count}
        onPress={() => navigation.navigate('Queue')}
      />
    </View>
  );
}

/** Root conversations open History; pushed conversations retain their native return path. */
export function useChatHeader(title: TitleInfo, onDelete: (() => Promise<void>) | null) {
  const navigation = useRootNavigation();
  const t = useTheme();
  const count = needsYouCount(useOverview().data);
  const route = useRoute<RouteProp<RootRoutes, 'Chat'>>();
  const hasChat = !!route.params?.id;
  const isRoot = useNavigationState((state) => state.routes[0]?.key === route.key);
  const [store] = useState(createTitleStore);
  const deleteRef = useRef(onDelete);
  deleteRef.current = onDelete;
  const canDelete = !!onDelete;
  const { name, kind, project, activity, elapsed } = title;
  useLayoutEffect(() => {
    store.set({ name, kind, project, activity, elapsed });
  }, [store, name, kind, project, activity, elapsed]);
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);
  useLayoutEffect(() => {
    const newChat = () => {
      Keyboard.dismiss();
      const state = navigation.getState();
      const current = state.routes[state.index];
      if (current.key !== route.key) return;
      navigation.dispatch(
        state.index > 0 && current.name === 'Chat' && current.params?.id
          ? StackActions.push('Chat')
          : StackActions.popTo('Chat'),
      );
    };
    const history = () => (
      <HeaderAction
        label="History"
        icon={Menu}
        testID="history-open"
        onPress={() => navigation.navigate('History')}
      />
    );
    const actions = () => <ConversationActions onNewChat={hasChat ? newChat : undefined} />;
    const options: NativeStackNavigationOptions = {
      headerTitle: () => (
        <ChatTitle store={store} onDelete={canDelete ? () => deleteRef.current?.() : undefined} />
      ),
      headerLeft: isRoot ? history : undefined,
      headerRight: actions,
      ...(Platform.OS === 'ios' && {
        unstable_headerLeftItems: isRoot
          ? () => [
              {
                type: 'button',
                label: 'History',
                accessibilityLabel: 'History',
                icon: { type: 'sfSymbol', name: 'line.3.horizontal' },
                width: 44,
                hidesSharedBackground: true,
                tintColor: t.text,
                onPress: () => {
                  Keyboard.dismiss();
                  navigation.navigate('History');
                },
              },
            ]
          : undefined,
        unstable_headerRightItems: () => [
          {
            type: 'button',
            label: 'Queue',
            accessibilityLabel: 'Queue',
            accessibilityHint: count ? `${count} items need you` : undefined,
            icon: { type: 'sfSymbol', name: 'tray' },
            width: 44,
            hidesSharedBackground: true,
            tintColor: t.text,
            badge: count
              ? { value: count, style: { backgroundColor: t.attentionSolid, color: '#FFFFFF' } }
              : undefined,
            onPress: () => {
              Keyboard.dismiss();
              navigation.navigate('Queue');
            },
          },
          ...(hasChat
            ? [
                {
                  type: 'button',
                  label: 'New chat',
                  accessibilityLabel: 'New chat',
                  icon: { type: 'sfSymbol', name: 'square.and.pencil' },
                  width: 44,
                  hidesSharedBackground: true,
                  tintColor: t.text,
                  onPress: newChat,
                } satisfies NativeStackHeaderItem,
              ]
            : []),
        ],
      }),
    };
    navigation.setOptions(options);
  }, [navigation, route.key, store, canDelete, hasChat, isRoot, count, t.text, t.attentionSolid]);
}

/** One tab per conversation in the chat. A filled dot marks a running one, a ring one parked on
 *  background work; the dots stay still because the header already pulses for this chat. */
export function SubChatTabs({
  data,
  onChange,
}: {
  data: MobileChatDetail;
  onChange: (id: string) => void;
}) {
  const t = useTheme();
  if (data.subChats.length < 2) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: GUTTER, paddingVertical: space.sm }}
    >
      {data.subChats.map((sub) => {
        const selected = sub.id === data.subChatId;
        return (
          <Pressable
            key={sub.id}
            accessibilityRole="tab"
            accessibilityLabel={sub.name || 'Conversation'}
            accessibilityState={{ selected }}
            aria-selected={selected}
            onPress={() => onChange(sub.id)}
            style={({ pressed }) => ({
              height: 32,
              maxWidth: 220,
              paddingHorizontal: space.md,
              borderRadius: radius.pill,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              backgroundColor: selected ? t.text : t.fill,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            {sub.activity !== 'idle' && (
              <View
                accessibilityLabel={sub.activity === 'running' ? 'Running' : 'Background'}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  borderWidth: 1.5,
                  borderColor: sub.activity === 'running' ? t.accent : t.secondary,
                  backgroundColor: sub.activity === 'running' ? t.accent : 'transparent',
                }}
              />
            )}
            <Text
              variant="secondary"
              numberOfLines={1}
              style={{
                flexShrink: 1,
                fontWeight: '600',
                color: selected ? t.background : t.secondary,
              }}
            >
              {sub.name || 'Conversation'}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
