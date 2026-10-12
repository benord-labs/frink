import * as SecureStore from 'expo-secure-store';

const KEY = 'frink.mobile.live-activity.v1';

/** The switch is on until turned off; a switch that fails to save is on again after a restart. */
export function readSwitch() {
  return SecureStore.getItemAsync(KEY).then(
    (saved) => saved !== 'off',
    () => true,
  );
}
export function saveSwitch(on: boolean) {
  SecureStore.setItemAsync(KEY, on ? 'on' : 'off').catch(() => undefined);
}
