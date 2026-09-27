import { useState } from 'react';
import { Pressable, StatusBar, Text, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ConnectionProvider, useConnection, useResource } from './src/lib/connection';
import { Chat, Chats, NewChat } from './src/screens/Chat';
import { FlowDetail, Flows, RunDetail } from './src/screens/Flows';
import { Pairing } from './src/screens/Pairing';
import { Queue } from './src/screens/Queue';
import { Button, Icon, Label, Loading, Notice, Page } from './src/ui/primitives';
import { useTheme } from './src/ui/theme';

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
  return (
    <Page title="Your computer" onBack={onBack}>
      <Icon name="laptop-outline" size={40} />
      <Label size={22} bold>
        {connection?.machineName}
      </Label>
      <Label muted>{connection?.url}</Label>
      {status.error ? (
        <Notice error>{status.error}</Notice>
      ) : status.data ? (
        <Notice>
          {status.data.executionReady
            ? 'Connected. Frink is ready for your work.'
            : 'Connected. Open a Frink window on your computer before running Flows.'}
        </Notice>
      ) : (
        <Loading />
      )}
      <Notice>
        Keep your computer awake, Frink open and Tailscale connected. The phone controls work on
        this computer.
      </Notice>
      <Label muted>
        For security, revoke this device in Settings → Mobile on your computer if you no longer use
        it.
      </Label>
      {error && <Notice error>{error}</Notice>}
      <Button
        secondary
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
  const [route, setRoute] = useState<Route>({ type: 'home' });
  const t = useTheme();
  const scheme = useColorScheme();
  const home = () => setRoute({ type: 'home' });
  const openChat = (id: string, subChatId?: string) => setRoute({ type: 'chat', id, subChatId });
  const openRun = (id: string) => setRoute({ type: 'run', id });
  let content;
  if (loading) content = <Loading />;
  else if (!connection) content = <Pairing />;
  else if (route.type === 'connection') content = <ConnectionDetails onBack={home} />;
  else if (route.type === 'flow')
    content = <FlowDetail key={route.id} id={route.id} onBack={home} openRun={openRun} />;
  else if (route.type === 'run')
    content = <RunDetail key={route.id} id={route.id} onBack={home} openChat={openChat} />;
  else if (route.type === 'chat')
    content = (
      <Chat
        key={`${route.id}:${route.subChatId ?? ''}`}
        id={route.id}
        initialSubChatId={route.subChatId}
        onBack={home}
      />
    );
  else if (route.type === 'new-chat') content = <NewChat onBack={home} openChat={openChat} />;
  else if (tab === 'flows') content = <Flows openFlow={(id) => setRoute({ type: 'flow', id })} />;
  else if (tab === 'chats')
    content = <Chats openChat={openChat} createChat={() => setRoute({ type: 'new-chat' })} />;
  else content = <Queue openChat={openChat} openRun={openRun} />;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} />
      {connection && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 20,
            borderBottomWidth: 1,
            borderColor: t.border,
          }}
        >
          <Text style={{ fontSize: 23, fontWeight: '700', color: t.text }}>frink</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Connection settings"
            onPress={() => setRoute({ type: 'connection' })}
            style={{
              minHeight: 48,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              maxWidth: '72%',
            }}
          >
            <Icon name="laptop-outline" size={17} color={t.muted} />
            <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>
              {connection.machineName}
            </Text>
          </Pressable>
        </View>
      )}
      <View style={{ flex: 1 }}>{content}</View>
      {connection && (
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: 'row',
            borderTopWidth: 1,
            borderColor: t.border,
            backgroundColor: t.surface,
          }}
        >
          {(
            [
              { id: 'queue', name: 'Queue', icon: 'layers-outline' },
              { id: 'flows', name: 'Flows', icon: 'git-network-outline' },
              { id: 'chats', name: 'Chats', icon: 'chatbubbles-outline' },
            ] as const
          ).map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityLabel={item.name}
              accessibilityState={{ selected: tab === item.id }}
              onPress={() => {
                setTab(item.id);
                home();
              }}
              style={{
                flex: 1,
                alignItems: 'center',
                gap: 5,
                paddingVertical: 12,
                minHeight: 64,
              }}
            >
              <Icon name={item.icon} color={tab === item.id ? t.accent : t.muted} />
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
      <ConnectionProvider>
        <SessionContent />
      </ConnectionProvider>
    </SafeAreaProvider>
  );
}
