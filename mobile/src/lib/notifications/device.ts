import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { PERMISSION_ALERT_CATEGORY } from '@frink/shared/types/remote/notifications';
import { AppState } from 'react-native';
import { isPermissionButton, PERMISSION_BUTTONS } from './actions';

let shownComputer: string | null = null;
/** The paired computer the app is showing; its alerts stay quiet while Frink is open. */
export function setShownComputer(deviceId: string | null) {
  shownComputer = deviceId;
}

// An alert that arrives while Frink is open stays in Notification Center without a banner, unless
// it comes from a paired computer other than the one on screen.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const from = notification.request.content.data?.deviceId;
    const elsewhere = typeof from === 'string' && from !== shownComputer;
    const quiet = AppState.currentState === 'active' && !elsewhere;
    return {
      shouldShowBanner: !quiet,
      shouldShowList: true,
      shouldPlaySound: !quiet,
      shouldSetBadge: false,
    };
  },
});

// Without the buttons registered, a permission alert still opens its chat when tapped.
Notifications.setNotificationCategoryAsync(PERMISSION_ALERT_CATEGORY, PERMISSION_BUTTONS).catch(
  () => undefined,
);

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

/** Calls `open` once per tapped alert or alert button, including the one that launched the app. */
export function onNotificationOpened(open: (data: unknown, action: string) => void) {
  let handled: string | undefined;
  const consume = (response: Notifications.NotificationResponse) => {
    const action = response.actionIdentifier;
    // One alert can be answered again with another button, so the same tap is what repeats.
    const tap = `${response.notification.request.identifier}\n${action}`;
    if (
      (action !== Notifications.DEFAULT_ACTION_IDENTIFIER && !isPermissionButton(action)) ||
      handled === tap
    )
      return;
    handled = tap;
    open(response.notification.request.content.data, action);
    Notifications.clearLastNotificationResponse();
  };
  const listener = Notifications.addNotificationResponseReceivedListener(consume);
  const initial = Notifications.getLastNotificationResponse();
  if (initial) consume(initial);
  return () => listener.remove();
}
