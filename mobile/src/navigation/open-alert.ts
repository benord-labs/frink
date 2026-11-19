import { CommonActions, StackActions, type NavigationState } from '@react-navigation/routers';
import type { AlertedComputer } from '../lib/notifications/routing';

/** The Queue tab back on its list, whatever was last opened inside it. */
export const SHOW_QUEUE = CommonActions.navigate('Tabs', {
  screen: 'QueueTab',
  params: { screen: 'Queue', pop: true },
});

/** A tapped alert opens its chat on top of the Chats tab, keeping what was open there beneath. */
export function alertActions(root: NavigationState | undefined, target: AlertedComputer['target']) {
  if (target === 'queue') return [SHOW_QUEUE];
  const tabs = root?.routes.find((route) => route.name === 'Tabs')?.state;
  const chats = tabs?.routes.find((route) => route.name === 'ChatsTab')?.state?.key;
  return [
    CommonActions.navigate('Tabs', { screen: 'ChatsTab' }),
    { ...StackActions.push('Chat', target), target: chats },
  ];
}
