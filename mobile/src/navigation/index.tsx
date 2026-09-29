import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect } from 'react';
import { Platform, StatusBar } from 'react-native';
import { useConnection } from '../lib/connection';
import { DraftProvider } from '../lib/drafts';
import { NotificationProvider } from '../lib/notifications';
import { onNotificationOpened } from '../lib/notifications/device';
import { notificationChat } from '../lib/notifications/routing';
import { OverviewProvider } from '../lib/overview';
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
  return (
    <OverviewProvider>
      <NotificationProvider>
        <Tabs />
      </NotificationProvider>
    </OverviewProvider>
  );
}

/** Tapping a "chat finished" alert opens that chat, if it came from the paired Mac. */
function useOpenAlertedChat() {
  const navigation = useRootNavigation();
  const deviceId = useConnection().connection?.deviceId;
  useEffect(
    () =>
      onNotificationOpened((data) => {
        const chat = deviceId && notificationChat(data, deviceId);
        if (chat) navigation.navigate('Chat', chat);
      }),
    [navigation, deviceId],
  );
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
