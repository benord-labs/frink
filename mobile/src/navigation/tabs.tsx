import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { enableScreens } from 'react-native-screens';
import { useTheme } from '../ui/theme';
import type { TabRoutes } from './routes';
import { TABS, tabBarHidden, useQueueBadge } from './tab-stacks';

const Tab = createBottomTabNavigator<TabRoutes>();
// Tabs out of view leave the page instead of staying behind the shown one, for screen readers too.
enableScreens(true);

const ICONS = Object.fromEntries(
  TABS.map(({ name, icon: Icon }) => [
    name,
    ({ color, size }: { color: string; size: number }) => <Icon color={color} size={size} />,
  ]),
);

/** The JavaScript tab bar, for platforms without native tabs (the web preview). */
export function Tabs() {
  const t = useTheme();
  const badge = useQueueBadge();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.muted,
        tabBarBadgeStyle: { backgroundColor: t.attentionSolid, color: '#FFFFFF' },
      }}
    >
      {TABS.map(({ name, title, component }) => (
        <Tab.Screen
          key={name}
          name={name}
          component={component}
          options={({ route }) => ({
            title,
            tabBarIcon: ICONS[name],
            tabBarBadge: name === 'QueueTab' ? badge : undefined,
            tabBarStyle: {
              backgroundColor: t.background,
              borderTopColor: t.borderSubtle,
              display: tabBarHidden(route) ? 'none' : 'flex',
            },
          })}
        />
      ))}
    </Tab.Navigator>
  );
}
