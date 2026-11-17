import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  StackActions,
  useNavigationContainerRef,
  type NavigationContainerRefWithCurrent,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
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
import { FlowsScreen } from '../screens/Flows';
import { HistoryScreen } from '../screens/History';
import { QueueScreen } from '../screens/Queue';
import { RunScreen } from '../screens/Run';
import { SettingsScreen } from '../screens/Settings';
import { useReduceMotion } from '../ui/glyphs';
import { useTheme } from '../ui/theme';
import type { RootRoutes } from './routes';

const Stack = createNativeStackNavigator<RootRoutes>();

/** Mounted after the navigator is ready, including after a selected-computer switch. */
function NavigationEvents({
  navigation,
}: {
  navigation: NavigationContainerRefWithCurrent<RootRoutes>;
}) {
  useOpenAlertedChat(navigation);
  useOpenQueueLink(navigation);
  return null;
}

/** A tapped alert for the computer on screen opens its chat, or the Queue for a chat-less task. */
function useOpenAlertedChat(navigation: NavigationContainerRefWithCurrent<RootRoutes>) {
  const { alert, done } = usePendingAlert(useConnection().connection?.deviceId);
  // Reason: Notification routing has browser tests; CRAP estimates zero without their coverage map.
  // fallow-ignore-next-line complexity
  useEffect(() => {
    if (!alert || !navigation.isReady()) return;
    const inHistory = navigation.getCurrentRoute()?.name === 'History';
    if (alert.target === 'queue') {
      if (inHistory) navigation.dispatch(StackActions.replace('Queue'));
      else navigation.navigate('Queue');
    } else {
      const action = inHistory ? StackActions.replace : StackActions.push;
      navigation.dispatch(action('Chat', alert.target));
    }
    done(alert);
    // `done` only clears this alert; the alert alone decides when to open.
  }, [navigation, alert]);
}

/** Tapping the Lock Screen card opens the Queue, including when the tap launched the app. */
function useOpenQueueLink(navigation: NavigationContainerRefWithCurrent<RootRoutes>) {
  useEffect(
    () =>
      onQueueLink(() => {
        if (!navigation.isReady()) return;
        if (navigation.getCurrentRoute()?.name === 'History')
          navigation.dispatch(StackActions.replace('Queue'));
        else navigation.navigate('Queue');
      }),
    [navigation],
  );
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

/** The conversation stays mounted beneath history and work destinations. */
function CompanionScreens() {
  const navigation = useNavigationContainerRef<RootRoutes>();
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const [ready, setReady] = useState(false);
  const deviceId = useConnection().connection?.deviceId;
  const base = t.dark ? DarkTheme : DefaultTheme;
  // A bar in the page's colour: the page scrolls away under its title instead of through it.
  const solid = {
    title: '',
    headerTransparent: false,
    headerStyle: { backgroundColor: t.background },
  };
  return (
    <>
      <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} />
      <NavigationContainer
        ref={navigation}
        onReady={() => setReady(true)}
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
                initialRouteName="Chat"
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
                {/* The transcript scrolls under the bar, so a material keeps it from showing through. */}
                <Stack.Screen
                  name="Chat"
                  component={ChatScreen}
                  options={{
                    title: '',
                    headerBlurEffect: t.solid ? 'none' : 'systemChromeMaterial',
                    headerStyle: { backgroundColor: t.solid ? t.background : 'transparent' },
                  }}
                />
                <Stack.Screen
                  name="Queue"
                  component={QueueScreen}
                  options={{ ...solid, title: 'Queue' }}
                />
                <Stack.Screen
                  name="Flows"
                  component={FlowsScreen}
                  options={{ ...solid, title: 'Flows' }}
                />
                <Stack.Screen
                  name="Settings"
                  component={SettingsScreen}
                  options={{ ...solid, title: 'Settings' }}
                />
                <Stack.Screen name="Flow" component={FlowScreen} options={solid} />
                <Stack.Screen name="Run" component={RunScreen} options={solid} />
                <Stack.Screen
                  name="History"
                  component={HistoryScreen}
                  options={{
                    headerShown: false,
                    presentation: 'transparentModal',
                    animation: reduceMotion ? 'none' : 'fade',
                    gestureEnabled: false,
                    contentStyle: { backgroundColor: 'transparent' },
                  }}
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
