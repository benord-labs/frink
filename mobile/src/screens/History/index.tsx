import { useCallback, useRef } from 'react';
import { useNavigationState } from '@react-navigation/native';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, Monitor, Settings, X } from 'lucide-react-native';
import { useConnection } from '../../lib/connection';
import { useOverview } from '../../lib/overview';
import { useRootNavigation, type RootRoutes } from '../../navigation/routes';
import { GlassSurface } from '../../ui/material';
import { Text } from '../../ui/text';
import { useTheme } from '../../ui/theme';
import { ChatsScreen } from '../Chats';
import { useHistoryFocus } from '../Chats/use-history-focus';
import { macStatus } from '../Settings/settings-view';

const mark = require('../../../assets/frink-mark.png');

export function HistoryScreen() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const root = useRootNavigation();
  const panel = useRef<View>(null);
  const closeButton = useRef<View>(null);
  const close = useCallback(() => root.goBack(), [root]);
  const selectedId = useNavigationState<RootRoutes, string | undefined>((state) => {
    const chat = state.routes
      .slice(0, state.index)
      .reverse()
      .find((route) => route.name === 'Chat');
    return chat?.params?.id;
  });
  useHistoryFocus(panel, closeButton, close);
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <Pressable
        testID="history-scrim"
        accessible={false}
        tabIndex={-1}
        onPress={close}
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.26)' }]}
      />
      <GlassSurface
        style={{
          flex: 1,
          width: Math.round(width * 0.88),
          marginLeft: 7,
          marginVertical: 8,
          borderRadius: 24,
          overflow: 'hidden',
        }}
      >
        <View
          ref={panel}
          testID="history-panel"
          accessibilityLabel="History"
          accessibilityViewIsModal
          onAccessibilityEscape={close}
          role={Platform.OS === 'web' ? 'dialog' : undefined}
          aria-modal={Platform.OS === 'web' ? true : undefined}
          style={{
            flex: 1,
            minHeight: 0,
            paddingTop: Math.max(insets.top - 8, 16),
          }}
        >
          <View
            style={{
              paddingHorizontal: 15,
              paddingBottom: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <View
              accessible
              accessibilityRole="header"
              accessibilityLabel="Frink"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <Image
                source={mark}
                accessible={false}
                style={{
                  width: 22,
                  height: 30,
                  resizeMode: 'contain',
                  tintColor: t.accent,
                }}
              />
              <Text variant="title">Frink</Text>
            </View>
            <Pressable
              ref={closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close history"
              onPress={close}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 22,
                backgroundColor: pressed ? t.pressed : 'transparent',
              })}
            >
              <X size={20} color={t.secondary} />
            </Pressable>
          </View>
          <ChatsScreen selectedId={selectedId} />
          <HistoryFooter bottom={Math.max(insets.bottom - 8, 12)} />
        </View>
      </GlassSurface>
    </KeyboardAvoidingView>
  );
}

// Reason: Computer navigation has browser tests; CRAP estimates zero without their coverage map.
// fallow-ignore-next-line complexity
function HistoryFooter({ bottom }: { bottom: number }) {
  const t = useTheme();
  const root = useRootNavigation();
  const overview = useOverview();
  const { connection } = useConnection();
  const name = overview.data?.machineName ?? connection?.machineName ?? 'Your computer';
  const status = macStatus(overview);
  const color =
    status.tone === 'live' ? t.live : status.tone === 'attention' ? t.attention : t.muted;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 10,
        paddingBottom: bottom,
        paddingHorizontal: 12,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        backgroundColor: t.fill,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Computer settings: ${name}`}
        onPress={() => root.replace('Settings')}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 9,
          borderRadius: 8,
          backgroundColor: pressed ? t.pressed : 'transparent',
        })}
      >
        <Monitor size={20} color={t.secondary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="secondary" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="secondary" style={{ color }}>
            {status.label}
          </Text>
        </View>
        <ChevronDown size={14} color={t.muted} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => root.replace('Settings')}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 22,
          backgroundColor: pressed ? t.pressed : 'transparent',
        })}
      >
        <Settings size={20} color={t.secondary} />
      </Pressable>
    </View>
  );
}
