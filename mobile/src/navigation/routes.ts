import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  useNavigation,
  type CompositeNavigationProp,
  type NavigationProp,
  type NavigatorScreenParams,
} from '@react-navigation/native';

export type DecisionTarget = { type: 'question' | 'permission'; id: string };
/** Every screen a tab's stack can hold; each tab registers the subset it needs. */
export type RootRoutes = {
  Chats: undefined;
  Queue: undefined;
  Flows: undefined;
  /** No `id` is a new chat: a blank conversation that is made on the Mac when it is first used. */
  Chat:
    | { id?: string; subChatId?: string; decisionTarget?: DecisionTarget; projectId?: string }
    | undefined;
  Flow: { id: string };
  Run: { id: string };
};
export type TabRoutes = {
  ChatsTab: NavigatorScreenParams<RootRoutes> | undefined;
  FlowsTab: NavigatorScreenParams<RootRoutes> | undefined;
  QueueTab: NavigatorScreenParams<RootRoutes> | undefined;
};
export type AppRoutes = {
  Tabs: NavigatorScreenParams<TabRoutes> | undefined;
  Settings: undefined;
};

type ScreenNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<RootRoutes>,
  CompositeNavigationProp<NavigationProp<TabRoutes>, NativeStackNavigationProp<AppRoutes>>
>;

/** A screen's own tab stack; tab switches and the Settings sheet are handed to its parents. */
export function useRootNavigation() {
  return useNavigation<ScreenNavigation>();
}
