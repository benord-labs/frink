import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { useOverview } from '../lib/overview';
import { needsYouCount } from '../screens/Queue/queue-view';
import { useTheme } from '../ui/theme';
import type { TabRoutes } from './routes';
import { TABS } from './tab-screens';

const Tab = createNativeBottomTabNavigator<TabRoutes>();

/** iOS: the system tab bar (Liquid Glass on iOS 26+), with native large-title headers. */
export function Tabs() {
  const t = useTheme();
  const needsYou = needsYouCount(useOverview().data);
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarActiveTintColor: t.accent,
        // The floating dock shrinks while reading a list and returns on scroll up.
        tabBarMinimizeBehavior: 'onScrollDown',
        // Native tab screens hide their header unless asked; the large title, search bar and
        // New chat button all live in it.
        headerShown: true,
        headerLargeTitleEnabled: true,
        headerTransparent: true,
        headerLargeTitleShadowVisible: false,
        headerTintColor: t.accent,
      }}
    >
      {TABS.map((tab) => (
        <Tab.Screen
          key={tab.name}
          name={tab.name}
          component={tab.component}
          options={{
            title: tab.title,
            tabBarIcon: { type: 'sfSymbol', name: tab.symbol },
            tabBarBadge: tab.name === 'Queue' && needsYou ? needsYou : undefined,
            tabBarBadgeStyle: { backgroundColor: t.attentionSolid },
          }}
        />
      ))}
    </Tab.Navigator>
  );
}
