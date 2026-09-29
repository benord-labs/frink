import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform, StatusBar } from 'react-native';
import { DraftProvider } from '../lib/drafts';
import { OverviewProvider } from '../lib/overview';
import { ChatScreen } from '../screens/Chat';
import { FlowScreen } from '../screens/Flow';
import { NewChatScreen } from '../screens/NewChat';
import { RunScreen } from '../screens/Run';
import { useReduceMotion } from '../ui/glyphs';
import { useTheme } from '../ui/theme';
import type { RootRoutes } from './routes';
import { Tabs } from './tabs';

const Stack = createNativeStackNavigator<RootRoutes>();

/** The shared overview (Queue badge) polls only while the tab bar is the visible screen. */
function TabsScreen() {
  return (
    <OverviewProvider>
      <Tabs />
    </OverviewProvider>
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
