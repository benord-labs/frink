import { useState } from 'react';
import { Image, Pressable, StatusBar, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ConnectionProvider, useConnection, useResource } from './src/lib/connection';
import { Chat, Chats, NewChat } from './src/screens/Chat';
import { FlowDetail, Flows, RunDetail } from './src/screens/Flows';
import { Pairing } from './src/screens/Pairing';
import { Queue } from './src/screens/Queue';
import { Button, Icon, Label, Loading, Notice, Page } from './src/ui/primitives';
import { ThemeProvider, useTheme } from './src/ui/theme';
import { Atmosphere } from './src/ui/material';

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
    <Page title="Your computer" onBack={onBack}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        <View style={{ width: 20, paddingTop: 2 }}>
          <Icon name="laptop-outline" size={20} color={t.secondary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          <Label size={16} bold>
            {connection?.machineName}
          </Label>
          <Label size={14} muted>
            {connection?.url}
          </Label>
        </View>
      </View>
      {status.error ? (
        <Notice error>{status.error}</Notice>
      ) : status.data ? (
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <View style={{ width: 20, paddingTop: 1 }}>
            <Icon
              name={
                status.data.executionReady
                  ? 'checkmark-circle-outline'
                  : 'information-circle-outline'
              }
              size={20}
              color={status.data.executionReady ? t.success : t.secondary}
            />
          </View>
          <Label size={14} style={{ flex: 1, lineHeight: 20 }}>
            {status.data.executionReady
              ? 'Connected. Frink is ready for your work.'
              : 'Connected. Open a Frink window on your computer before running Flows.'}
          </Label>
        </View>
      ) : (
        <Loading />
      )}
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
  const title = tab === 'queue' ? 'Work queue' : tab === 'flows' ? 'Flows' : 'Chats';
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
  else if (tab === 'chats') content = <Chats openChat={openChat} />;
  else content = <Queue openChat={openChat} openRun={openRun} />;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
      <Atmosphere />
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} />
      {connection && route.type === 'home' && (
        <View
          style={{
            minHeight: 56,
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 20,
            paddingRight: 8,
            gap: 8,
          }}
        >
          <View
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Image
              source={require('./assets/icon.png')}
              accessibilityIgnoresInvertColors
              style={{ width: 20, height: 24, tintColor: t.accent }}
            />
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={{
                flex: 1,
                fontSize: 20,
                lineHeight: 26,
                fontWeight: '600',
                color: t.text,
              }}
            >
              {title}
            </Text>
          </View>
          {tab === 'chats' && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New chat"
              onPress={() => navigate({ type: 'new-chat' })}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.65 : 1,
              })}
            >
              <Icon name="create-outline" size={20} color={t.text} />
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Connection settings"
            onPress={() => navigate({ type: 'connection' })}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Icon name="laptop-outline" size={20} color={t.secondary} />
          </Pressable>
        </View>
      )}
      <View style={{ flex: 1 }}>{content}</View>
      {connection && route.type === 'home' && (
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: 'row',
            backgroundColor: t.surface,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderColor: t.border,
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
              accessibilityState={{ selected: tab === item.id }}
              onPress={() => {
                setTab(item.id);
                home();
              }}
              style={{
                flex: 1,
                alignItems: 'center',
                gap: 4,
                paddingVertical: 8,
                minHeight: 60,
                justifyContent: 'center',
              }}
            >
              <Icon name={item.icon} size={20} color={tab === item.id ? t.accent : t.muted} />
              <Text
                style={{
                  color: tab === item.id ? t.accent : t.muted,
                  fontSize: 12,
                  lineHeight: 16,
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
