import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

// An alert that arrives while Frink is open stays in Notification Center without a banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: AppState.currentState !== 'active',
    shouldShowList: true,
    shouldPlaySound: AppState.currentState !== 'active',
    shouldSetBadge: false,
  }),
});

/** Whether alerts are allowed; only `ask` shows the system prompt. Provisional counts as allowed. */
export async function permission(ask = false): Promise<boolean> {
  const result = ask
    ? await Notifications.requestPermissionsAsync()
    : await Notifications.getPermissionsAsync();
  return result.granted || result.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

export async function pushToken(): Promise<string> {
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) throw new Error('This Frink build can’t receive alerts.');
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

export function onTokenChanged(refresh: () => void) {
  const listener = Notifications.addPushTokenListener(refresh);
  return () => listener.remove();
}

/** Calls `open` once per tapped alert, including the one that launched the app. */
export function onNotificationOpened(open: (data: unknown) => void) {
  let handled: string | undefined;
  const consume = (response: Notifications.NotificationResponse) => {
    if (
      response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER ||
      handled === response.notification.request.identifier
    )
      return;
    handled = response.notification.request.identifier;
    open(response.notification.request.content.data);
    Notifications.clearLastNotificationResponse();
  };
  const listener = Notifications.addNotificationResponseReceivedListener(consume);
  const initial = Notifications.getLastNotificationResponse();
  if (initial) consume(initial);
  return () => listener.remove();
}
