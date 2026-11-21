import type {
  NavigationProp,
  NavigationState,
  ParamListBase,
  Route,
} from '@react-navigation/native';

type TabScreenNavigation = Pick<NavigationProp<ParamListBase>, 'getParent'>;

/** A screen that belongs to the deleted chat: the chat itself or its changes. */
function isDeletedChat({ name, params }: Route<string>, chatId: string) {
  if (!params) return false;
  if (name === 'Chat') return 'id' in params && params.id === chatId;
  return name === 'Changes' && 'chatId' in params && params.chatId === chatId;
}

/** Drop the deleted chat from every tab's stack; each stack lands on what lay beneath it. */
export function afterChatDeletion(state: NavigationState, chatId: string): NavigationState {
  const routes = state.routes
    .filter((route) => !isDeletedChat(route, chatId))
    .map((route) =>
      route.state?.stale === false
        ? { ...route, state: afterChatDeletion(route.state, chatId) }
        : route,
    );
  return { ...state, routes, index: Math.min(state.index, routes.length - 1) };
}

/** From a screen inside a tab, closes the deleted chat in every tab at once. */
export function closeDeletedChat(navigation: TabScreenNavigation, chatId: string) {
  const root = navigation.getParent()?.getParent();
  root?.reset(afterChatDeletion(root.getState(), chatId));
}
