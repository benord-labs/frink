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
  Chat: { id: string; subChatId?: string; decisionTarget?: DecisionTarget };
  Flow: { id: string };
  Run: { id: string };
  NewChat: { projectId?: string } | undefined;
};

/** Every screen navigates through the root stack: details push above the tab bar. */
export function useRootNavigation() {
  return useNavigation<NativeStackNavigationProp<RootRoutes>>();
}
