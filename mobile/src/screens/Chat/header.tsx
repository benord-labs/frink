import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import type { MobileActivity, MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { PulseDot } from '../../ui/glyphs';
import { Text } from '../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../ui/theme';

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
  let value: TitleInfo = { name: '', kind: undefined, project: undefined, activity: undefined, elapsed: '' };
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

/** Two lines in the navigation bar: the chat's name, then Chat or Flow, its project and state.
 *  Violet and the pulse mean running; parked background work stays calm grey, as in the list. */
function ChatTitle({ store }: { store: TitleStore }) {
  const t = useTheme();
  const { name, kind, project, activity, elapsed } = useSyncExternalStore(
    store.subscribe,
    store.get,
  );
  const state = activity ? activityWords(activity, elapsed) : null;
  const words = [kind && (kind === 'flow' ? 'Flow' : 'Chat'), project].filter(Boolean);
  return (
    <View
      accessibilityRole="header"
      style={{ alignItems: Platform.OS === 'ios' ? 'center' : 'flex-start', maxWidth: 250 }}
    >
      <Text variant="headline" numberOfLines={1}>
        {name}
      </Text>
      {(words.length > 0 || state) && (
        <View
          testID="chat-subtitle"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' }}
        >
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
      )}
    </View>
  );
}

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Delete chat"
      onPress={onDelete}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Trash2 size={19} color={t.secondary} strokeWidth={2} />
    </Pressable>
  );
}

/** The native header for a chat: two-line title and a menu whose one item deletes the chat. */
export function useChatHeader(title: TitleInfo, onDelete: (() => void) | null) {
  const navigation = useNavigation();
  const [store] = useState(createTitleStore);
  const deleteRef = useRef(onDelete);
  deleteRef.current = onDelete;
  const canDelete = !!onDelete;
  const { name, kind, project, activity, elapsed } = title;
  useLayoutEffect(() => {
    store.set({ name, kind, project, activity, elapsed });
  }, [store, name, kind, project, activity, elapsed]);
  // `title` names the screen for the back button and the web tab; the bar shows ChatTitle.
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);
  useLayoutEffect(() => {
    const remove = () => deleteRef.current?.();
    const options: NativeStackNavigationOptions = {
      headerTitle: () => <ChatTitle store={store} />,
    };
    if (Platform.OS === 'ios')
      options.unstable_headerRightItems = canDelete
        ? () => [
            {
              type: 'menu',
              label: 'Chat options',
              icon: { type: 'sfSymbol', name: 'ellipsis' },
              menu: {
                items: [
                  {
                    type: 'action',
                    label: 'Delete chat',
                    icon: { type: 'sfSymbol', name: 'trash' },
                    destructive: true,
                    onPress: remove,
                  },
                ],
              },
            },
          ]
        : undefined;
    else options.headerRight = canDelete ? () => <DeleteButton onDelete={remove} /> : undefined;
    navigation.setOptions(options);
  }, [navigation, store, canDelete]);
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
