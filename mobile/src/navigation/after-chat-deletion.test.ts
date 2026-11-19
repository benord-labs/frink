import { describe, expect, it } from 'vitest';
import {
  CommonActions,
  StackRouter,
  TabRouter,
  type NavigationState,
  type ParamListBase,
  type Route,
  type StackNavigationState,
} from '@react-navigation/routers';
import { afterChatDeletion } from './after-chat-deletion';

const stackRouter = StackRouter({});
const stackOptions = {
  routeNames: ['Chats', 'Flows', 'Queue', 'Chat', 'Run', 'Flow'],
  routeParamList: {},
  routeGetIdList: {},
};
const rootOptions = { ...stackOptions, routeNames: ['Tabs', 'Settings'] };

function stack(routes: Route<string>[]): StackNavigationState<ParamListBase> {
  return { ...stackRouter.getInitialState(stackOptions), routes, index: routes.length - 1 };
}

function root(stacks: NavigationState[]): StackNavigationState<ParamListBase> {
  const tabOptions = { ...stackOptions, routeNames: ['ChatsTab', 'FlowsTab', 'QueueTab'] };
  const tabs = TabRouter({}).getInitialState(tabOptions);
  return {
    ...stackRouter.getInitialState(rootOptions),
    routes: [
      {
        key: 'tabs',
        name: 'Tabs',
        state: {
          ...tabs,
          index: 2,
          routes: tabs.routes.map((route, index) => ({ ...route, state: stacks[index] })),
        },
      },
    ],
  };
}

function tabStacks(state: NavigationState) {
  return state.routes[0].state?.routes.map((tab) => tab.state?.routes.map((route) => route.key));
}

describe('deleting a conversation', () => {
  it('removes the chat from every tab and keeps the tab that was on screen', () => {
    const state = root([
      stack([
        { key: 'chats', name: 'Chats' },
        { key: 'chats-a', name: 'Chat', params: { id: 'a' } },
      ]),
      stack([
        { key: 'flows', name: 'Flows' },
        { key: 'flows-b', name: 'Chat', params: { id: 'b' } },
      ]),
      stack([
        { key: 'queue', name: 'Queue' },
        { key: 'queue-a', name: 'Chat', params: { id: 'a' } },
      ]),
    ]);
    const result = afterChatDeletion(state, 'a');
    expect(tabStacks(result)).toEqual([['chats'], ['flows', 'flows-b'], ['queue']]);
    expect(result.routes[0].state?.index).toBe(2);
    const reset = stackRouter.getStateForAction(state, CommonActions.reset(result), rootOptions);
    expect(reset).toEqual(result);
  });

  it('pops the open chat to the previous screen and drops retained copies', () => {
    const flows = stack([
      { key: 'flows', name: 'Flows' },
      { key: 'run', name: 'Run', params: { id: 'run-1' } },
      { key: 'older', name: 'Chat', params: { id: 'a' } },
      { key: 'other', name: 'Chat', params: { id: 'b' } },
      { key: 'chat', name: 'Chat', params: { id: 'a' } },
    ]);
    const result = afterChatDeletion(flows, 'a');
    expect(result.routes.map((route) => route.key)).toEqual(['flows', 'run', 'other']);
    expect(result.index).toBe(2);
    const reset = stackRouter.getStateForAction(flows, CommonActions.reset(result), stackOptions);
    expect(reset?.routes.at(-1)?.key).toBe('other');
  });
});
