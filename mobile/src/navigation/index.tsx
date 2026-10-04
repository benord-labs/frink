import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect } from 'react';
import { Platform, StatusBar } from 'react-native';
import { useConnection } from '../lib/connection';
import { DraftProvider } from '../lib/drafts';
import { LiveActivityProvider } from '../lib/live-activity';
import { NotificationProvider } from '../lib/notifications';
import { usePendingAlert } from '../lib/notifications/alert-open';
import { OverviewProvider } from '../lib/overview';
import { onQueueLink } from '../lib/pairing-link';
import { ChatScreen } from '../screens/Chat';
import { FlowScreen } from '../screens/Flow';
import { RunScreen } from '../screens/Run';
import { useReduceMotion } from '../ui/glyphs';
import { useTheme } from '../ui/theme';
import { useRootNavigation, type RootRoutes } from './routes';
import { Tabs } from './tabs';

const Stack = createNativeStackNavigator<RootRoutes>();

/** The shared overview (Queue badge) polls only while the tab bar is the visible screen. */
function TabsScreen() {
  useOpenAlertedChat();
  useOpenQueueLink();
  const deviceId = useConnection().connection?.deviceId;
  return (
    <OverviewProvider>
      {/* One provider per computer, so no alert request or state ever crosses to another. */}
      <NotificationProvider key={deviceId}>
        <LiveActivityProvider>
          <Tabs />
        </LiveActivityProvider>
      </NotificationProvider>
    </OverviewProvider>
  );
}

/** A tapped alert for the computer on screen opens its chat, or the Queue for a chat-less task. */
function useOpenAlertedChat() {
  const navigation = useRootNavigation();
  const { alert, done } = usePendingAlert(useConnection().connection?.deviceId);
  useEffect(() => {
    if (!alert) return;
    done(alert);
    if (alert.target === 'queue') navigation.navigate('Tabs', { screen: 'Queue' });
    else navigation.navigate('Chat', alert.target);
    // `done` only clears this alert; the alert alone decides when to open.
  }, [navigation, alert]);
}

/** Tapping the Lock Screen card opens the Queue, including when the tap launched the app. */
function useOpenQueueLink() {
  const navigation = useRootNavigation();
  useEffect(() => onQueueLink(() => navigation.navigate('Tabs', { screen: 'Queue' })), [navigation]);
}

const ios = Platform.OS === 'ios';

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

/** Tabs at the root; Chat, Flow and Run push above them (the tab bar hides, as in Messages). */
function CompanionScreens() {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const base = t.dark ? DarkTheme : DefaultTheme;
  return (
    <>
      <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} />
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
            animation: reduceMotion ? 'none' : 'default',
            contentStyle: { backgroundColor: t.background },
            headerTransparent: ios,
            // Content scrolls under the transparent bar; the material keeps it from showing through the title.
            headerBlurEffect: 'systemChromeMaterial',
            headerTintColor: t.accent,
            headerBackButtonDisplayMode: 'minimal',
            headerTitleAlign: 'center',
            headerTitleStyle: { color: t.text },
            headerStyle: ios ? undefined : { backgroundColor: t.background },
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="Tabs" component={TabsScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Chat" component={ChatScreen} options={{ title: '' }} />
          <Stack.Screen name="Flow" component={FlowScreen} options={{ title: '' }} />
          <Stack.Screen name="Run" component={RunScreen} options={{ title: '' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}
