import { getFocusedRouteNameFromRoute, type RouteProp } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from '@react-navigation/native-stack';
import { Platform } from 'react-native';
import { Inbox, MessageCircle, Workflow } from 'lucide-react-native';
import { useOverview } from '../lib/overview';
import { ChatScreen } from '../screens/Chat';
import { ChatsScreen } from '../screens/Chats';
import { FlowScreen } from '../screens/Flow';
import { FlowsScreen } from '../screens/Flows';
import { QueueScreen } from '../screens/Queue';
import { needsYouCount } from '../screens/Queue/queue-view';
import { RunScreen } from '../screens/Run';
import { useReduceMotion } from '../ui/glyphs';
import { useTheme } from '../ui/theme';
import { ComputerButton } from './computer-button';
import type { RootRoutes, TabRoutes } from './routes';

const Stack = createNativeStackNavigator<RootRoutes>();
const ios = Platform.OS === 'ios';
const computer = () => <ComputerButton />;

function useStackOptions() {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const screenOptions: NativeStackNavigationOptions = {
    animation: reduceMotion ? 'none' : 'default',
    contentStyle: { backgroundColor: t.background },
    headerTransparent: ios,
    headerTintColor: t.accent,
    headerBackButtonDisplayMode: 'minimal',
    headerTitleAlign: 'center',
    headerTitleStyle: { color: t.text },
    headerStyle: ios ? undefined : { backgroundColor: t.background },
    headerShadowVisible: false,
  };
  // A bar in the page's colour: the page scrolls away under its title instead of through it.
  const solid: NativeStackNavigationOptions = {
    title: '',
    headerTransparent: false,
    headerStyle: { backgroundColor: t.background },
  };
  // The transcript scrolls under the bar, so a material keeps it from showing through.
  const chat: NativeStackNavigationOptions = {
    title: '',
    headerBlurEffect: t.solid ? 'none' : 'systemChromeMaterial',
    headerStyle: { backgroundColor: t.solid ? t.background : 'transparent' },
  };
  return { screenOptions, solid, chat };
}

function ChatsStack() {
  const { screenOptions, solid, chat } = useStackOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="Chats"
        component={ChatsScreen}
        options={{ ...solid, headerRight: computer }}
      />
      <Stack.Screen name="Chat" component={ChatScreen} options={chat} />
    </Stack.Navigator>
  );
}

function FlowsStack() {
  const { screenOptions, solid, chat } = useStackOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="Flows"
        component={FlowsScreen}
        options={{ ...solid, headerRight: computer }}
      />
      <Stack.Screen name="Flow" component={FlowScreen} options={solid} />
      <Stack.Screen name="Run" component={RunScreen} options={solid} />
      <Stack.Screen name="Chat" component={ChatScreen} options={chat} />
    </Stack.Navigator>
  );
}

function QueueStack() {
  const { screenOptions, solid, chat } = useStackOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="Queue"
        component={QueueScreen}
        options={{ ...solid, headerRight: computer }}
      />
      <Stack.Screen name="Chat" component={ChatScreen} options={chat} />
      <Stack.Screen name="Run" component={RunScreen} options={solid} />
      <Stack.Screen name="Flow" component={FlowScreen} options={solid} />
    </Stack.Navigator>
  );
}

/** The tab bar's destinations, shared by the native iOS bar and the web preview's bar. */
export const TABS = [
  {
    name: 'ChatsTab',
    title: 'Chats',
    component: ChatsStack,
    symbol: 'bubble.left',
    icon: MessageCircle,
  },
  { name: 'FlowsTab', title: 'Flows', component: FlowsStack, symbol: 'flowchart', icon: Workflow },
  { name: 'QueueTab', title: 'Queue', component: QueueStack, symbol: 'tray', icon: Inbox },
] as const;

/** A conversation keeps the whole height for its transcript and composer. */
export function tabBarHidden(route: RouteProp<TabRoutes>) {
  return getFocusedRouteNameFromRoute(route) === 'Chat';
}

/** The Queue tab's badge: how many items need you, or none. */
export function useQueueBadge() {
  return needsYouCount(useOverview().data) || undefined;
}
