import { useState } from 'react';
import { Image, Pressable, StatusBar, Text, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ConnectionProvider, useConnection, useResource } from './src/lib/connection';
import { Chat, Chats, NewChat } from './src/screens/Chat';
import { FlowDetail, Flows, RunDetail } from './src/screens/Flows';
import { Pairing } from './src/screens/Pairing';
import { Queue } from './src/screens/Queue';
import { Button, Icon, Label, Loading, Notice, Page } from './src/ui/primitives';
import { ThemeProvider, useTheme } from './src/ui/theme';
import { Atmosphere, glassStyle } from './src/ui/material';

type Tab = 'queue' | 'flows' | 'chats';
type Route =
  | { type: 'home' }
  | { type: 'connection' }
  | { type: 'flow' | 'run'; id: string }
  | { type: 'chat'; id: string; subChatId?: string }
  | { type: 'new-chat' };

// Reason: Connection status and revocation feedback stay together for the MVP.
// fallow-ignore-next-line complexity
function ConnectionDetails({ onBack }: { onBack: () => void }) {
  const { connection, disconnect } = useConnection();
  const status = useResource({ type: 'overview' });
  const [error, setError] = useState<string | null>(null);
  const t = useTheme();
  return (
    <Page title="Your computer" onBack={onBack} compact>
      <View
        style={{
          ...glassStyle(t),
          borderRadius: 14,
          overflow: 'hidden',
        }}
      >
        <View style={{ padding: 18, flexDirection: 'row', gap: 13, alignItems: 'flex-start' }}>
          <View
            style={{
              backgroundColor: t.field,
              borderRadius: 10,
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="laptop-outline" size={24} color={t.secondary} />
          </View>
          <View style={{ flex: 1, gap: 5 }}>
            <Label size={19} bold>
              {connection?.machineName}
            </Label>
            <Label size={13} muted>
              {connection?.url}
            </Label>
          </View>
        </View>
        <View style={{ padding: 16, borderTopWidth: 1, borderColor: t.border }}>
          {status.error ? (
            <Notice error>{status.error}</Notice>
          ) : status.data ? (
            <View style={{ flexDirection: 'row', gap: 9, alignItems: 'flex-start' }}>
              <View style={{ paddingTop: 1 }}>
                <Icon
                  name={
                    status.data.executionReady
                      ? 'checkmark-circle-outline'
                      : 'information-circle-outline'
                  }
                  size={19}
                  color={status.data.executionReady ? t.success : t.secondary}
                />
              </View>
              <Label size={14} style={{ flex: 1 }}>
                {status.data.executionReady
                  ? 'Connected. Frink is ready for your work.'
                  : 'Connected. Open a Frink window on your computer before running Flows.'}
              </Label>
            </View>
          ) : (
            <Loading />
          )}
        </View>
      </View>
      <View style={{ gap: 10 }}>
        <Label size={14}>
          Keep your computer awake, Frink open and Tailscale connected. The phone controls work on
          this computer.
        </Label>
        <Label muted size={13}>
          For security, revoke this device in Settings → Mobile on your computer if you no longer
          use it.
        </Label>
      </View>
      {error && <Notice error>{error}</Notice>}
      <Button
        compact
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

// Reason: The MVP has a small explicit route and connection state tree.
// fallow-ignore-next-line complexity
function Companion() {
  const { connection, loading } = useConnection();
  const [tab, setTab] = useState<Tab>('queue');
  const [history, setHistory] = useState<Route[]>([{ type: 'home' }]);
  const route = history[history.length - 1];
  const t = useTheme();
  const scheme = useColorScheme();
  const home = () => setHistory([{ type: 'home' }]);
  const back = () => setHistory((current) => (current.length > 1 ? current.slice(0, -1) : current));
  const navigate = (next: Route) => setHistory((current) => [...current, next]);
  const openChat = (id: string, subChatId?: string) => {
    setHistory((current) => [
      ...current.slice(0, current[current.length - 1].type === 'new-chat' ? -1 : undefined),
      { type: 'chat', id, subChatId },
    ]);
  };
  const openRun = (id: string) => navigate({ type: 'run', id });
  let content;
  if (loading) content = <Loading />;
  else if (!connection) content = <Pairing />;
  else if (route.type === 'connection') content = <ConnectionDetails onBack={back} />;
  else if (route.type === 'flow')
    content = <FlowDetail key={route.id} id={route.id} onBack={back} openRun={openRun} />;
  else if (route.type === 'run')
    content = <RunDetail key={route.id} id={route.id} onBack={back} openChat={openChat} />;
  else if (route.type === 'chat')
    content = (
      <Chat
        key={`${route.id}:${route.subChatId ?? ''}`}
        id={route.id}
        initialSubChatId={route.subChatId}
        onBack={back}
      />
    );
  else if (route.type === 'new-chat') content = <NewChat onBack={back} openChat={openChat} />;
  else if (tab === 'flows') content = <Flows openFlow={(id) => navigate({ type: 'flow', id })} />;
  else if (tab === 'chats')
    content = <Chats openChat={openChat} createChat={() => navigate({ type: 'new-chat' })} />;
  else content = <Queue openChat={openChat} openRun={openRun} />;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
      <Atmosphere />
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} />
      {connection && route.type === 'home' && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingTop: 4,
            paddingBottom: 4,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Image
              source={require('./assets/icon.png')}
              style={{ width: 23, height: 28, tintColor: t.accent }}
            />
            <Text style={{ fontSize: 20, fontWeight: '400', letterSpacing: -0.7, color: t.text }}>
              Frink
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Connection settings"
            onPress={() => navigate({ type: 'connection' })}
            style={{
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              maxWidth: '72%',
            }}
          >
            <Icon name="laptop-outline" size={15} color={t.muted} />
            <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>
              {connection.machineName}
            </Text>
          </Pressable>
        </View>
      )}
      <View style={{ flex: 1 }}>{content}</View>
      {connection && route.type === 'home' && (
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: 'row',
            ...glassStyle(t),
            borderLeftWidth: 0,
            borderRightWidth: 0,
            borderBottomWidth: 0,
          }}
        >
          {(
            [
              { id: 'queue', name: 'Queue', icon: 'file-tray-stacked-outline' },
              { id: 'flows', name: 'Flows', icon: 'git-network-outline' },
              { id: 'chats', name: 'Chats', icon: 'chatbubbles-outline' },
            ] as const
          ).map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityLabel={item.name}
              aria-selected={tab === item.id}
              onPress={() => {
                setTab(item.id);
                home();
              }}
              style={{
                flex: 1,
                alignItems: 'center',
                gap: 4,
                paddingVertical: 9,
                minHeight: 58,
              }}
            >
              <Icon name={item.icon} size={20} color={tab === item.id ? t.accent : t.muted} />
              <Text
                style={{
                  color: tab === item.id ? t.accent : t.muted,
                  fontSize: 12,
                  fontWeight: '500',
                }}
              >
                {item.name}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

function SessionContent() {
  const { connection } = useConnection();
  return <Companion key={connection?.deviceId ?? 'unpaired'} />;
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
