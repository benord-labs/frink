import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { useTheme } from '../ui/theme';
import type { TabRoutes } from './routes';
import { TABS, tabBarHidden, useQueueBadge } from './tab-stacks';

const Tab = createNativeBottomTabNavigator<TabRoutes>();

/** The system tab bar, with SF Symbols and the system badge. */
export function Tabs() {
  const t = useTheme();
  const badge = useQueueBadge();
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarActiveTintColor: t.accent,
        tabBarBadgeStyle: { backgroundColor: t.attentionSolid, color: '#FFFFFF' },
      }}
    >
      {TABS.map(({ name, title, component, symbol }) => (
        <Tab.Screen
          key={name}
          name={name}
          component={component}
          options={({ route }) => ({
            title,
            tabBarIcon: { type: 'sfSymbol', name: symbol },
            tabBarBadge: name === 'QueueTab' ? badge : undefined,
            tabBarStyle: { display: tabBarHidden(route) ? 'none' : 'flex' },
          })}
        />
      ))}
    </Tab.Navigator>
  );
}
