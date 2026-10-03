// Browser previews: the browser's own notification permission stands in for iOS's. A browser has
// no iPhone push token, so turning alerts on in a preview stops at the token step.
export async function permission(ask = false): Promise<boolean> {
  return (ask ? await Notification.requestPermission() : Notification.permission) === 'granted';
}
export async function pushToken(): Promise<string> {
  throw new Error('Alerts need the Frink iPhone app.');
}
export function onTokenChanged(_refresh: () => void) {
  return () => {};
}
export function setShownComputer(_deviceId: string | null) {}
export function onNotificationOpened(_open: (data: unknown) => void) {
  return () => {};
}
