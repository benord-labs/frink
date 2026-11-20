import { CommonActions, StackActions, type NavigationState } from '@react-navigation/routers';
import type { AlertedComputer } from '../lib/notifications/routing';

// `pop` returns to the existing tabs, closing Settings above them, instead of pushing a copy.
/** The Queue tab back on its list, whatever was last opened inside it. Built fresh each time,
 *  because the navigator treats params it has seen before as already applied. */
export function showQueue() {
  return CommonActions.navigate(
    'Tabs',
    { screen: 'QueueTab', params: { screen: 'Queue', pop: true } },
    { pop: true },
  );
}

/** A tapped alert opens its chat on top of the Chats tab, keeping what was open there beneath. */
export function alertActions(root: NavigationState | undefined, target: AlertedComputer['target']) {
  if (target === 'queue') return [showQueue()];
  const tabs = root?.routes.find((route) => route.name === 'Tabs')?.state;
  const chats = tabs?.routes.find((route) => route.name === 'ChatsTab')?.state?.key;
  return [
    CommonActions.navigate('Tabs', { screen: 'ChatsTab' }, { pop: true }),
    { ...StackActions.push('Chat', target), target: chats },
  ];
}
