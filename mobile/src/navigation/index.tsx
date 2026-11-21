import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  useNavigationContainerRef,
  type NavigationContainerRefWithCurrent,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { StatusBar } from 'react-native';
import { useConnection } from '../lib/connection';
import { DraftProvider } from '../lib/drafts';
import { lastChatSaver } from '../lib/last-chat';
import { LiveActivityProvider } from '../lib/live-activity';
import { NotificationProvider } from '../lib/notifications';
import { usePendingAlert } from '../lib/notifications/alert-open';
import { OverviewProvider } from '../lib/overview';
import { onQueueLink } from '../lib/pairing-link';
import { appStore } from '../lib/storage';
import { SettingsScreen } from '../screens/Settings';
import { useReduceMotion } from '../ui/glyphs';
import { useTheme } from '../ui/theme';
import { alertActions, showQueue } from './open-alert';
import type { AppRoutes } from './routes';
import { Tabs } from './tabs';

const Stack = createNativeStackNavigator<AppRoutes>();
const saveLastChat = lastChatSaver(appStore);
type Navigation = NavigationContainerRefWithCurrent<AppRoutes>;

/** Mounted after the navigator is ready, including after a selected-computer switch. */
function NavigationEvents({ navigation }: { navigation: Navigation }) {
  useOpenAlertedChat(navigation);
  useOpenQueueLink(navigation);
  return null;
}

/** A tapped alert for the computer on screen opens its chat, or the Queue for a chat-less task. */
function useOpenAlertedChat(navigation: Navigation) {
  const { alert, done } = usePendingAlert(useConnection().connection?.deviceId);
  useEffect(() => {
    if (!alert || !navigation.isReady()) return;
    for (const action of alertActions(navigation.getRootState(), alert.target))
      navigation.dispatch(action);
    done(alert);
    // `done` only clears this alert; the alert alone decides when to open.
  }, [navigation, alert]);
}

/** Tapping the Lock Screen card opens the Queue, including when the tap launched the app. */
function useOpenQueueLink(navigation: Navigation) {
  useEffect(
    () =>
      onQueueLink(() => {
        if (navigation.isReady()) navigation.dispatch(showQueue());
      }),
    [navigation],
  );
}

/** Remembers the conversation on screen, so the next launch reopens it. */
function rememberChat(navigation: Navigation, deviceId: string | undefined) {
  const route = navigation.getCurrentRoute();
  if (!deviceId || !route || route.name === 'Settings' || route.name === 'Changes') return;
  // Voice mode belongs to its chat, so a relaunch reopens that chat.
  const chat = route.name === 'Chat' || route.name === 'Voice' ? route.params : undefined;
  void saveLastChat(deviceId, chat?.id ? { id: chat.id, subChatId: chat.subChatId } : null);
}

/**
 * The app for the computer on screen. Switching computers remounts its screens, so none shows
 * another computer's data, while drafts sit above them and survive the switch.
 */
export function Companion() {
  const { connection } = useConnection();
  return (
    <DraftProvider>
      <CompanionScreens key={`${connection?.deviceId}:${connection?.route}`} />
    </DraftProvider>
  );
}

/** Each tab keeps its own stack; Settings opens over them as a sheet. */
function CompanionScreens() {
  const navigation = useNavigationContainerRef<AppRoutes>();
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const [ready, setReady] = useState(false);
  const deviceId = useConnection().connection?.deviceId;
  const base = t.dark ? DarkTheme : DefaultTheme;
  return (
    <>
      <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} />
      <NavigationContainer
        ref={navigation}
        onReady={() => setReady(true)}
        onStateChange={() => rememberChat(navigation, deviceId)}
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
        <OverviewProvider>
          <NotificationProvider key={deviceId}>
            <LiveActivityProvider>
              <Stack.Navigator
                screenOptions={{
                  animation: reduceMotion ? 'none' : 'default',
                  contentStyle: { backgroundColor: t.background },
                  headerTintColor: t.accent,
                  headerTitleAlign: 'center',
                  headerTitleStyle: { color: t.text },
                  headerStyle: { backgroundColor: t.background },
                  headerShadowVisible: false,
                }}
              >
                <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
                <Stack.Screen
                  name="Settings"
                  component={SettingsScreen}
                  options={{ title: 'Settings', presentation: 'modal' }}
                />
              </Stack.Navigator>
              {ready && <NavigationEvents navigation={navigation} />}
            </LiveActivityProvider>
          </NotificationProvider>
        </OverviewProvider>
      </NavigationContainer>
    </>
  );
}
