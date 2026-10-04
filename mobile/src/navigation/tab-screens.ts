import { FlowsScreen } from '../screens/Flows';
import { ChatsScreen } from '../screens/Chats';
import { QueueScreen } from '../screens/Queue';
import { SettingsScreen } from '../screens/Settings';

/** 22pt SF Symbol images keep the native dock's icons smaller than its fixed system-symbol size. */
export const TABS = [
  {
    name: 'Queue',
    component: QueueScreen,
    icon: require('../../assets/navigation/tray.png'),
    selectedIcon: require('../../assets/navigation/tray.fill.png'),
    title: 'Queue',
  },
  {
    name: 'Chats',
    component: ChatsScreen,
    icon: require('../../assets/navigation/bubble.left.png'),
    selectedIcon: require('../../assets/navigation/bubble.left.fill.png'),
    title: 'Chats',
  },
  {
    name: 'Flows',
    component: FlowsScreen,
    icon: require('../../assets/navigation/flowchart.png'),
    selectedIcon: require('../../assets/navigation/flowchart.fill.png'),
    title: 'Flows',
  },
  {
    name: 'Settings',
    component: SettingsScreen,
    icon: require('../../assets/navigation/gearshape.png'),
    selectedIcon: require('../../assets/navigation/gearshape.fill.png'),
    title: 'Settings',
  },
] as const;
