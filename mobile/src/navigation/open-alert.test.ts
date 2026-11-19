import { describe, expect, it } from 'vitest';
import {
  StackRouter,
  TabRouter,
  type NavigationState,
  type ParamListBase,
  type Route,
  type StackNavigationState,
} from '@react-navigation/routers';
import { alertActions, SHOW_QUEUE } from './open-alert';

const stackOptions = {
  routeNames: ['Chats', 'Queue', 'Chat', 'Run', 'Flow'],
  routeParamList: {},
  routeGetIdList: {},
};
const stackRouter = StackRouter({});

function stack(key: string, routes: Route<string>[]): StackNavigationState<ParamListBase> {
  return {
    ...stackRouter.getInitialState(stackOptions),
    key,
    routes,
    index: routes.length - 1,
  };
}

function root(chats: NavigationState, focused: 'ChatsTab' | 'QueueTab'): NavigationState {
  const tabOptions = { ...stackOptions, routeNames: ['ChatsTab', 'FlowsTab', 'QueueTab'] };
  const tabs = TabRouter({}).getInitialState(tabOptions);
  return {
    ...stackRouter.getInitialState({ ...stackOptions, routeNames: ['Tabs', 'Settings'] }),
    routes: [
      {
        key: 'tabs',
        name: 'Tabs',
        state: {
          ...tabs,
          index: tabs.routeNames.indexOf(focused),
          routes: tabs.routes.map((route) =>
            route.name === 'ChatsTab' ? { ...route, state: chats } : route,
          ),
        },
      },
    ],
  };
}

function apply(
  state: StackNavigationState<ParamListBase>,
  action: Parameters<typeof stackRouter.getStateForAction>[1],
) {
  return stackRouter.getStateForAction(state, action, stackOptions);
}

describe('opening a tapped alert', () => {
  it('opens the alerted chat over the chat already open in the Chats tab', () => {
    const chats = stack('chats-stack', [
      { key: 'list', name: 'Chats' },
      { key: 'open', name: 'Chat', params: { id: 'a', subChatId: 's1' } },
    ]);
    const [, push] = alertActions(root(chats, 'QueueTab'), { id: 'a', subChatId: 's2' });
    expect(push.target).toBe('chats-stack');
    const next = apply(chats, push);
    expect(next?.routes.map((route) => route.params)).toEqual([
      undefined,
      { id: 'a', subChatId: 's1' },
      { id: 'a', subChatId: 's2' },
    ]);
  });

  it('returns the Queue tab to its list for a chat-less alert', () => {
    expect(alertActions(root(stack('chats-stack', []), 'ChatsTab'), 'queue')).toEqual([SHOW_QUEUE]);
    expect(SHOW_QUEUE).toMatchObject({
      payload: {
        name: 'Tabs',
        params: { screen: 'QueueTab', params: { screen: 'Queue', pop: true } },
      },
    });
  });
});
