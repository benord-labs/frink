import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect } from 'react';
import { Platform, StatusBar } from 'react-native';
import { useConnection } from '../lib/connection';
import { DraftProvider } from '../lib/drafts';
import { LiveActivityProvider } from '../lib/live-activity';
import { NotificationProvider } from '../lib/notifications';
import { onNotificationOpened } from '../lib/notifications/device';
import { notificationTarget } from '../lib/notifications/routing';
import { OverviewProvider } from '../lib/overview';
import { onQueueLink } from '../lib/pairing-link';
import { ChatScreen } from '../screens/Chat';
import { FlowScreen } from '../screens/Flow';
import { NewChatScreen } from '../screens/NewChat';
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
  return (
    <OverviewProvider>
      <NotificationProvider>
        <LiveActivityProvider>
          <Tabs />
        </LiveActivityProvider>
      </NotificationProvider>
    </OverviewProvider>
  );
}

/** Tapping an alert from the paired Mac opens its chat, or the Queue for a chat-less task. */
function useOpenAlertedChat() {
  const navigation = useRootNavigation();
  const deviceId = useConnection().connection?.deviceId;
  useEffect(
    () =>
      onNotificationOpened((data) => {
        const target = deviceId && notificationTarget(data, deviceId);
        if (target === 'queue') navigation.navigate('Tabs', { screen: 'Queue' });
        else if (target) navigation.navigate('Chat', target);
      }),
    [navigation, deviceId],
  );
}

/** Tapping the Lock Screen card opens the Queue, including when the tap launched the app. */
function useOpenQueueLink() {
  const navigation = useRootNavigation();
  useEffect(() => onQueueLink(() => navigation.navigate('Tabs', { screen: 'Queue' })), [navigation]);
}

const ios = Platform.OS === 'ios';

/** Tabs at the root; Chat, Flow and Run push above them (the tab bar hides, as in Messages). */
export function Companion() {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const base = t.dark ? DarkTheme : DefaultTheme;
  return (
    <DraftProvider>
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
          <Stack.Screen
            name="NewChat"
            component={NewChatScreen}
            options={{
              title: 'New chat',
              presentation: ios ? 'formSheet' : 'modal',
              sheetAllowedDetents: [1],
              sheetGrabberVisible: true,
              headerTransparent: false,
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </DraftProvider>
  );
}
