import { useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  NavigationContainer,
  DarkTheme,
  DefaultTheme,
  useIsFocused,
  type RouteProp,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack';
import {
  ConnectionProvider,
  ResourceActivity,
  useConnection,
  useResource,
} from './src/lib/connection';
import Constants from 'expo-constants';
import { DraftProvider } from './src/lib/drafts';
import { Chat, Chats, NewChat } from './src/screens/Chat';
import { FlowDetail, Flows, RunDetail } from './src/screens/Flows';
import { Pairing } from './src/screens/Pairing';
import { Queue } from './src/screens/Queue';
import { needsYouCount } from './src/screens/Queue/queue-view';
import { Button, Card, Icon, IconTile, Label, Loading, Notice } from './src/ui/primitives';
import { Page } from './src/ui/page';
import { ThemeProvider, useTheme } from './src/ui/theme';
import { Atmosphere } from './src/ui/material';
import { TabBar, type Tab } from './src/ui/tab-bar';

type CodeSource = { branch?: string; commit?: string; checkout?: string };

/** Checkout · branch · commit the running JavaScript came from, when Metro's config knew it. */
function AppCode() {
  const source = Constants.expoConfig?.extra?.source as CodeSource | undefined;
  if (!source?.commit) return null;
  return (
    <Label muted size={13} lines={2}>
      App code: {[source.checkout, source.branch, source.commit].filter(Boolean).join(' · ')}
    </Label>
  );
}

// Reason: Connection status and revocation feedback stay together for the MVP.
// fallow-ignore-next-line complexity
function ConnectionDetails({ onBack }: { onBack: () => void }) {
  const { connection, disconnect } = useConnection();
  const status = useResource({ type: 'overview' });
  const [error, setError] = useState<string | null>(null);
  const t = useTheme();
  return (
    <Page title="Your computer" onBack={onBack}>
      <Card>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14 }}>
          <IconTile name="laptop-outline" />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label size={16} bold>
              {connection?.machineName}
            </Label>
            <Label size={14} muted lines={1}>
              {connection?.url}
            </Label>
          </View>
        </View>
        <View
          style={{
            flexDirection: 'row',
            gap: 12,
            alignItems: 'center',
            padding: 14,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderColor: t.border,
          }}
        >
          {status.error ? (
            <Notice error>{status.error}</Notice>
          ) : status.data ? (
            <>
              <IconTile
                name={status.data.executionReady ? 'checkmark' : 'information'}
                tone={status.data.executionReady ? 'success' : 'warning'}
              />
              <Label size={15} style={{ flex: 1 }}>
                {status.data.executionReady
                  ? 'Connected. Frink is ready for your work.'
                  : 'Connected. Open a Frink window on your computer before running Flows.'}
              </Label>
            </>
          ) : (
            <Loading />
          )}
        </View>
      </Card>
      <View style={{ gap: 8, paddingHorizontal: 4 }}>
        <Label size={14} muted>
          Keep your computer awake, Frink open and Tailscale connected. The phone controls work on
          this computer.
        </Label>
        <Label muted size={14}>
          For security, revoke this device in Settings → Mobile on your computer if you no longer
          use it.
        </Label>
        <AppCode />
      </View>
      {error && <Notice error>{error}</Notice>}
      <Button
        secondary
        destructive
        icon="log-out-outline"
        onPress={async () => {
          try {
            await disconnect();
          } catch {
            setError(
              'The connection is closed, but Keychain could not be cleared. Revoke this device on your computer.',
            );
          }
        }}
      >
        Disconnect this phone
      </Button>
    </Page>
  );
}

const Stack = createNativeStackNavigator<Routes>();
type DecisionTarget = { type: 'question' | 'permission'; id: string };
type Routes = {
  Home: undefined;
  Connection: undefined;
  Flow: { id: string };
  Run: { id: string };
  Chat: { id: string; subChatId?: string; decisionTarget?: DecisionTarget };
  NewChat: undefined;
};
type RouteProps = {
  route: { [Name in keyof Routes]: RouteProp<Routes, Name> }[keyof Routes];
  navigation: NativeStackNavigationProp<Routes>;
};

function ScreenFrame({ children, tabs = false }: { children: ReactNode; tabs?: boolean }) {
  const focused = useIsFocused();
  const t = useTheme();
  return (
    <ResourceActivity.Provider value={focused}>
      <SafeAreaView
        edges={tabs ? ['top'] : ['top', 'bottom']}
        style={{ flex: 1, backgroundColor: t.background }}
      >
        <Atmosphere />
        {children}
      </SafeAreaView>
    </ResourceActivity.Provider>
  );
}

function Home({ navigation }: NativeStackScreenProps<Routes, 'Home'>) {
  return (
    <ScreenFrame tabs>
      <HomeContent navigation={navigation} />
    </ScreenFrame>
  );
}

// Inside ScreenFrame, so the shared overview polls only while Home is the visible screen.
// Reason: Header actions and tab content switch with the selected tab.
// fallow-ignore-next-line complexity
function HomeContent({ navigation }: Pick<NativeStackScreenProps<Routes, 'Home'>, 'navigation'>) {
  const [tab, setTab] = useState<Tab>('queue');
  const t = useTheme();
  const { connection } = useConnection();
  const insets = useSafeAreaInsets();
  // Home owns the overview so the Queue tab badge stays current while another tab is open.
  const overview = useResource({ type: 'overview' });
  const needsYou = needsYouCount(overview.data);
  const title = tab === 'queue' ? 'Work queue' : tab === 'flows' ? 'Flows' : 'Chats';
  const openChat = (id: string, subChatId?: string, decisionTarget?: DecisionTarget) =>
    navigation.push('Chat', { id, subChatId, decisionTarget });
  return (
    <>
      <View
        style={{
          paddingLeft: 20,
          paddingRight: 12,
          paddingTop: 12,
          paddingBottom: 12,
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 8,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            accessibilityRole="header"
            style={{
              fontSize: 30,
              lineHeight: 36,
              fontWeight: '700',
              letterSpacing: -0.6,
              color: t.text,
            }}
          >
            {title}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="laptop-outline" size={14} color={t.muted} />
            <Text numberOfLines={1} style={{ fontSize: 14, lineHeight: 18, color: t.muted }}>
              {connection?.machineName}
            </Text>
          </View>
        </View>
        {tab === 'chats' && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New chat"
            onPress={() => navigation.push('NewChat')}
            hitSlop={4}
            style={[styles.iconButton, { backgroundColor: t.accentSoft }]}
          >
            <Icon name="add" size={22} color={t.accent} />
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Connection settings"
          onPress={() => navigation.push('Connection')}
          hitSlop={4}
          style={[styles.iconButton, { backgroundColor: t.field }]}
        >
          <Icon name="laptop-outline" size={18} color={t.secondary} />
        </Pressable>
      </View>
      <View style={{ flex: 1 }}>
        {tab === 'queue' ? (
          <Queue
            resource={overview}
            openChat={openChat}
            openRun={(id) => navigation.push('Run', { id })}
          />
        ) : tab === 'flows' ? (
          <Flows openFlow={(id) => navigation.push('Flow', { id })} />
        ) : (
          <Chats openChat={openChat} />
        )}
      </View>
      <TabBar tab={tab} onChange={setTab} needsYou={needsYou} bottomInset={insets.bottom} />
    </>
  );
}

// Reason: One case per stack route.
// fallow-ignore-next-line complexity
function DetailScreen({ route, navigation }: RouteProps) {
  const onBack = () => navigation.goBack();
  let content: ReactNode;
  switch (route.name) {
    case 'Connection':
      content = <ConnectionDetails onBack={onBack} />;
      break;
    case 'Flow':
      content = (
        <FlowDetail
          id={route.params.id}
          onBack={onBack}
          openRun={(id) => navigation.push('Run', { id })}
        />
      );
      break;
    case 'Run':
      content = (
        <RunDetail
          id={route.params.id}
          onBack={onBack}
          openChat={(id, subChatId) => navigation.push('Chat', { id, subChatId })}
        />
      );
      break;
    case 'Chat':
      content = (
        <Chat
          id={route.params.id}
          initialSubChatId={route.params.subChatId}
          decisionTarget={route.params.decisionTarget}
          onBack={onBack}
        />
      );
      break;
    case 'NewChat':
      content = (
        <NewChat
          onBack={onBack}
          openChat={(id, subChatId) => navigation.replace('Chat', { id, subChatId })}
        />
      );
      break;
    default:
      content = null;
  }
  return <ScreenFrame>{content}</ScreenFrame>;
}

function Companion() {
  const t = useTheme();
  const scheme = useColorScheme();
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  const base = scheme === 'light' ? DefaultTheme : DarkTheme;
  return (
    <DraftProvider>
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} />
      <NavigationContainer
        theme={{
          ...base,
          colors: {
            ...base.colors,
            background: t.background,
            card: t.solidSurface,
            text: t.text,
            primary: t.accent,
            border: t.border,
          },
        }}
      >
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            animation: reduceMotion ? 'none' : 'default',
            contentStyle: { backgroundColor: t.background },
          }}
        >
          <Stack.Screen name="Home" component={Home} />
          <Stack.Screen name="Connection" component={DetailScreen} />
          <Stack.Screen name="Flow" component={DetailScreen} />
          <Stack.Screen name="Run" component={DetailScreen} />
          <Stack.Screen name="Chat" component={DetailScreen} />
          <Stack.Screen name="NewChat" component={DetailScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </DraftProvider>
  );
}

function SessionContent() {
  const { connection, loading } = useConnection();
  const t = useTheme();
  if (loading || !connection)
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
        <Atmosphere />
        {loading ? <Loading /> : <Pairing />}
      </SafeAreaView>
    );
  return <Companion key={`${connection.deviceId}:${connection.url}`} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ConnectionProvider>
          <SessionContent />
        </ConnectionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginBottom: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
