import type { StackNavigationState } from '@react-navigation/native';
import type { RootRoutes } from './routes';

/** Clear every retained copy of the deleted chat and return a pushed detail to its origin. */
export function afterChatDeletion(state: StackNavigationState<RootRoutes>, chatId: string) {
  const current = state.routes[state.index];
  const leaving = current.name === 'Chat' && current.params?.id === chatId && state.index > 0;
  const routes = state.routes
    .filter((route) => !leaving || route.key !== current.key)
    .map((route) =>
      route.name === 'Chat' && route.params?.id === chatId
        ? { ...route, params: undefined }
        : route,
    );
  return { ...state, routes, index: leaving ? state.index - 1 : state.index };
}
