import { FlowsScreen } from '../screens/Flows';
import { ChatsScreen } from '../screens/Chats';
import { QueueScreen } from '../screens/Queue';
import { SettingsScreen } from '../screens/Settings';

/** The four tabs, in order. `symbol` is the iOS SF Symbol; `icon` is the web (lucide) glyph. */
export const TABS = [
  { name: 'Queue', component: QueueScreen, symbol: 'tray.full', title: 'Queue' },
  {
    name: 'Chats',
    component: ChatsScreen,
    symbol: 'bubble.left.and.bubble.right',
    title: 'Chats',
  },
  {
    name: 'Flows',
    component: FlowsScreen,
    symbol: 'point.3.connected.trianglepath.dotted',
    title: 'Flows',
  },
  { name: 'Settings', component: SettingsScreen, symbol: 'gearshape', title: 'Settings' },
] as const;
