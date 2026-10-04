import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';

export type DecisionTarget = { type: 'question' | 'permission'; id: string };
export type TabRoutes = {
  Queue: undefined;
  Chats: undefined;
  Flows: undefined;
  Settings: undefined;
};
export type RootRoutes = {
  Tabs: NavigatorScreenParams<TabRoutes> | undefined;
  /** No `id` is a new chat: a blank conversation that is made on the Mac when it is first used. */
  Chat:
    | { id?: string; subChatId?: string; decisionTarget?: DecisionTarget; projectId?: string }
    | undefined;
  Flow: { id: string };
  Run: { id: string };
};

/** Every screen navigates through the root stack: details push above the tab bar. */
export function useRootNavigation() {
  return useNavigation<NativeStackNavigationProp<RootRoutes>>();
}
