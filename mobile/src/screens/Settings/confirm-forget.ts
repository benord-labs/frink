import { Alert, Platform } from 'react-native';

const TITLE = 'Forget this Mac?';
export const REVOKE_HINT =
  'To fully remove access, also remove this iPhone under Paired phones in Frink on your Mac → Settings → Mobile.';
const MESSAGE = `This iPhone stops showing your Mac until you pair it again. ${REVOKE_HINT}`;

/** The system confirm: an iOS alert with a destructive button, or the browser dialog on web previews. */
export function confirmForget(): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${TITLE}\n\n${MESSAGE}`));
  return new Promise((resolve) =>
    Alert.alert(TITLE, MESSAGE, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Forget', style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}
