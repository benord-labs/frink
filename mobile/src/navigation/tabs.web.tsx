import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Inbox, MessageCircle, Settings, Workflow, type LucideIcon } from 'lucide-react-native';
import { StyleSheet } from 'react-native';
import { GlassSurface } from '../ui/material';
import { useOverview } from '../lib/overview';
import { needsYouCount } from '../screens/Queue/queue-view';
import { useTheme } from '../ui/theme';
import type { TabRoutes } from './routes';
import { TABS } from './tab-screens';

const Tab = createBottomTabNavigator<TabRoutes>();
const DOCK_HEIGHT = 62;
const DOCK_BOTTOM = 20;
const ICONS: Record<keyof TabRoutes, LucideIcon> = {
  Queue: Inbox,
  Chats: MessageCircle,
  Flows: Workflow,
  Settings,
};

/** Web (Playwright previews only): react-navigation's JS tab bar over a blur. */
export function Tabs() {
  const t = useTheme();
  const needsYou = needsYouCount(useOverview().data);
  return (
    <Tab.Navigator
      safeAreaInsets={{ bottom: 0 }}
      screenOptions={({ route }) => {
        const Icon = ICONS[route.name];
        return {
          headerShown: false,
          tabBarActiveTintColor: t.accent,
          tabBarInactiveTintColor: t.muted,
          tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
          // iOS 26's floating dock: a glass capsule above the home indicator, not an edge bar.
          tabBarStyle: {
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: DOCK_BOTTOM,
            height: DOCK_HEIGHT,
            paddingTop: 0,
            paddingBottom: 0,
            paddingHorizontal: 4,
            borderRadius: DOCK_HEIGHT / 2,
            borderTopWidth: 0,
            backgroundColor: 'transparent',
            overflow: 'hidden',
          },
          // The library paints the highlight square on an inner view; clipping here rounds it into
          // an inset pill that never touches the dock's edge.
          tabBarItemStyle: {
            marginVertical: 5,
            marginHorizontal: 2,
            borderRadius: (DOCK_HEIGHT - 10) / 2,
            overflow: 'hidden',
          },
          tabBarActiveBackgroundColor: t.fill,
          tabBarBackground: () => (
            <GlassSurface style={[StyleSheet.absoluteFill, { borderRadius: DOCK_HEIGHT / 2 }]} />
          ),
          tabBarIcon: ({ color }) => <Icon size={22} color={color} strokeWidth={1.8} />,
          tabBarBadgeStyle: { backgroundColor: t.attentionSolid, color: '#FFFFFF', fontSize: 12 },
          tabBarButtonTestID: `tab-${route.name.toLowerCase()}`,
        };
      }}
    >
      {TABS.map((tab) => (
        <Tab.Screen
          key={tab.name}
          name={tab.name}
          component={tab.component}
          options={{
            title: tab.title,
            tabBarBadge: tab.name === 'Queue' && needsYou ? needsYou : undefined,
          }}
        />
      ))}
    </Tab.Navigator>
  );
}
