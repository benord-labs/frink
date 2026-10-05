import { describe, expect, it } from 'vitest';
import { StackRouter } from '@react-navigation/routers';
import { afterChatDeletion } from './after-chat-deletion';
import type { StackNavigationState } from '@react-navigation/native';
import type { RootRoutes } from './routes';

const router = StackRouter({ initialRouteName: 'Chat' });
const options = {
  routeNames: ['Chat', 'History', 'Queue', 'Flows', 'Settings', 'Flow', 'Run'] satisfies Array<
    keyof RootRoutes
  >,
  routeParamList: {},
  routeGetIdList: {},
};
function stack(
  routes: StackNavigationState<RootRoutes>['routes'],
): StackNavigationState<RootRoutes> {
  return {
    ...router.getInitialState(options),
    routeNames: options.routeNames,
    preloadedRoutes: [],
    routes,
    index: routes.length - 1,
  };
}

describe('deleting a conversation with retained navigation', () => {
  it('returns a pushed duplicate to Queue without keeping a deleted root transcript', () => {
    const state = stack([
      { key: 'root', name: 'Chat', params: { id: 'a', subChatId: 'a-sub' } },
      { key: 'queue', name: 'Queue' },
      { key: 'detail', name: 'Chat', params: { id: 'a' } },
    ]);
    const result = afterChatDeletion(state, 'a');
    expect(result.routes).toEqual([
      { key: 'root', name: 'Chat', params: undefined },
      { key: 'queue', name: 'Queue' },
    ]);
    const back = router.getStateForAction(result, { type: 'GO_BACK' }, options);
    expect(back?.index).toBe(0);
    expect(back?.routes[0]).toMatchObject({ key: 'root', name: 'Chat', params: undefined });
    expect(state.routes[0].params).toEqual({ id: 'a', subChatId: 'a-sub' });
  });

  it('keeps another conversation and the detail origin intact', () => {
    const state = stack([
      { key: 'root', name: 'Chat', params: { id: 'a' } },
      { key: 'run', name: 'Run', params: { id: 'run-1' } },
      { key: 'detail', name: 'Chat', params: { id: 'b' } },
    ]);
    const result = afterChatDeletion(state, 'b');
    expect(result.routes).toEqual(state.routes.slice(0, 2));
    expect(result.routes[result.index].name).toBe('Run');
  });

  it('clears the selected conversation while History stays open', () => {
    const state = stack([
      {
        key: 'root',
        name: 'Chat',
        params: { id: 'a', decisionTarget: { type: 'question', id: 'q' } },
      },
      { key: 'history', name: 'History' },
    ]);
    const result = afterChatDeletion(state, 'a');
    expect(result.routes[result.index].name).toBe('History');
    expect(result.routes[0].params).toBeUndefined();
    expect(afterChatDeletion(stack([state.routes[0]]), 'a').routes).toEqual([
      { key: 'root', name: 'Chat', params: undefined },
    ]);
  });
});
